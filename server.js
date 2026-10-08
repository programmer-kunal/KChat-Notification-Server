try { require("dotenv").config(); } catch (e) {}
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK using Render environment variable
if (!admin.apps || !admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://chatter-e0e10-default-rtdb.firebaseio.com",
    });
  } else {
    // Local / development fallback
    admin.initializeApp({
      projectId: "chatter-e0e10",
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://chatter-e0e10-default-rtdb.firebaseio.com",
    });
  }
}

// Universal SDK helpers compatible across all firebase-admin versions (v10 - v13)
const getAdminAuth = () => {
  if (typeof admin.auth === "function") return admin.auth();
  const { getAuth } = require("firebase-admin/auth");
  return getAuth();
};

const getAdminDb = () => {
  if (typeof admin.database === "function") return admin.database();
  const { getDatabase } = require("firebase-admin/database");
  return getDatabase();
};

const getAdminMessaging = () => {
  if (typeof admin.messaging === "function") return admin.messaging();
  const { getMessaging } = require("firebase-admin/messaging");
  return getMessaging();
};

app.get("/", (req, res) => {
  res.send("KChat Notification & Media Server Running 🚀");
});

// Authentication middleware using native Firebase ID Token
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.warn("[AUTH] Rejected: Missing or malformed Authorization header");
    return res.status(401).json({
      success: false,
      error: "Unauthorized: Missing or malformed Bearer token in Authorization header",
    });
  }

  const idToken = authHeader.split("Bearer ")[1].trim();
  if (!idToken) {
    console.warn("[AUTH] Rejected: Empty token");
    return res.status(401).json({
      success: false,
      error: "Unauthorized: Empty Bearer token",
    });
  }

  try {
    const decodedToken = await getAdminAuth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("[AUTH] Verification failed:", error.message);
    return res.status(401).json({
      success: false,
      error: `Unauthorized: Invalid token (${error.message})`,
    });
  }
};

// Send push notification endpoint
const sendNotificationHandler = async (req, res) => {
  const authenticatedUid = req.user.uid;
  const { topic, title, body, data, receiverUid } = req.body;

  // Security Logging (Strictly sanitized: NO ID tokens, NO FCM tokens, NO credentials logged)
  console.log(`[NOTIFICATION_REQUEST] Caller UID: ${authenticatedUid}, Receiver UID: ${receiverUid || "none"}, Channel ID: ${data?.channelId || "none"}`);

  try {
    // Authorization: Verify caller is not impersonating another sender
    const claimedSenderId = req.body.senderId || data?.senderId;
    if (claimedSenderId && claimedSenderId !== authenticatedUid) {
      console.warn(`[AUTH] Forbidden: Caller ${authenticatedUid} attempted to send notification claiming senderId ${claimedSenderId}`);
      return res.status(403).json({
        success: false,
        error: "Forbidden: senderId does not match authenticated user",
      });
    }

    // Server-side secure token resolution (NO raw client tokens accepted)
    let targetToken = null;

    if (receiverUid) {
      const db = getAdminDb();
      // 1. Primary secure location: /user_private/{receiverUid}/fcmToken
      try {
        const privateSnap = await db.ref(`user_private/${receiverUid}/fcmToken`).once("value");
        targetToken = privateSnap.val();
      } catch (err) {
        console.warn(`[DB] Could not read /user_private for UID ${receiverUid}:`, err.message);
      }

      // 2. Backward compatibility fallback: /users/{receiverUid}/fcmToken
      if (!targetToken) {
        try {
          const publicSnap = await db.ref(`users/${receiverUid}/fcmToken`).once("value");
          targetToken = publicSnap.val();
        } catch (err) {
          console.warn(`[DB] Could not read fallback /users for UID ${receiverUid}:`, err.message);
        }
      }
    }

    // DATA-ONLY MESSAGE
    // Forces Android to deliver the message to FirebaseMessageService.onMessageReceived()
    // Authoritative senderId is strictly the authenticated Firebase UID
    const message = {
      data: {
        title: String(title || ""),
        body: String(body || ""),
        senderId: String(authenticatedUid),
        channelId: String(data?.channelId || req.body.channelId || ""),
        senderName: String(data?.senderName || req.body.senderName || ""),
        senderImage: String(data?.senderImage || req.body.senderImage || ""),
        messageId: String(data?.messageId || req.body.messageId || ""),
        channelName: String(data?.channelName || req.body.channelName || ""),
        messageText: String(data?.messageText || req.body.messageText || body || ""),
      },
      android: {
        priority: "high",
      },
    };

    // Target selection: Only server-resolved targetToken or validated topic
    if (targetToken) {
      message.token = targetToken;
    } else if (topic) {
      message.topic = topic.startsWith("/topics/")
        ? topic.replace("/topics/", "")
        : topic;
    } else {
      throw new Error(
        `Missing recipient target: No token resolved for receiverUid '${receiverUid}' and no topic supplied.`
      );
    }

    const response = await getAdminMessaging().send(message);

    console.log(`[FCM_SUCCESS] Push dispatched successfully for receiver UID: ${receiverUid || "topic"}`);

    // Return only generic message ID - do NOT leak receiver FCM token
    res.status(200).json({
      success: true,
      messageId: response,
    });
  } catch (error) {
    console.error("[FCM_ERROR] Delivery failed:", error.message);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ============================================================================
// PHASE 2 MEDIA AUTHORIZATION & SIGNED URL MANAGEMENT
// ============================================================================

/**
 * Validates channel authorization against Firebase RTDB.
 * Never trusts client claims: exclusively uses authenticated Firebase UID.
 */
const verifyChannelMembership = async (authenticatedUid, channelId) => {
  if (!channelId || typeof channelId !== "string") {
    return { authorized: false, reason: "Missing or invalid channelId" };
  }

  // World Chat is public and explicitly does not use private vault authorization
  if (channelId === "world_chat") {
    return {
      authorized: false,
      isWorldChat: true,
      reason: "World Chat media is public and does not require private vault authorization",
    };
  }

  // Self Chat: self_chat_<uid>
  if (channelId.startsWith("self_chat_")) {
    const ownerUid = channelId.replace("self_chat_", "");
    if (ownerUid === authenticatedUid) {
      return { authorized: true, type: "self_chat" };
    }
    return { authorized: false, reason: "Forbidden: You are not the owner of this self-chat" };
  }

  // Direct 1-on-1 Chat: format is <uid1>_<uid2>
  const isDirectChat = channelId.includes("_") && !channelId.startsWith("-");
  if (isDirectChat) {
    if (channelId.startsWith(authenticatedUid + "_") || channelId.endsWith("_" + authenticatedUid)) {
      return { authorized: true, type: "direct_chat" };
    }
    const participants = channelId.split("_");
    if (participants.includes(authenticatedUid)) {
      return { authorized: true, type: "direct_chat", participants };
    }
    return { authorized: false, reason: "Forbidden: You are not a participant in this conversation" };
  }

  // Custom Group Chat: group push key (typically starts with "-") or channel name
  try {
    const db = getAdminDb();
    const memberSnap = await db.ref(`channels/${channelId}/users/${authenticatedUid}`).once("value");
    if (memberSnap.val() === true) {
      return { authorized: true, type: "group_chat" };
    }
    return { authorized: false, reason: "Forbidden: You are not a member of this group" };
  } catch (err) {
    console.error("[MEMBERSHIP_CHECK] Firebase RTDB error:", err.message);
    return { authorized: false, reason: "Database error verifying group membership" };
  }
};

/**
 * Safely validates objectPath to prevent directory traversal, absolute paths, backslashes, empty, or malformed paths.
 */
const validateObjectPath = (path) => {
  if (!path || typeof path !== "string" || path.trim().length === 0) {
    return { valid: false, error: "Missing or empty objectPath" };
  }
  const trimmed = path.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    return {
      valid: false,
      error: "Invalid objectPath: Path traversal, absolute paths, backslashes, or malformed paths are forbidden",
    };
  }
  return { valid: true, sanitizedPath: trimmed };
};

/**
 * Generates a short-lived Supabase signed URL using service-role credentials.
 * Never logs credentials, private keys, or the generated token.
 */
const generateSupabaseSignedUrl = async (bucket, objectPath, expiresIn = 300) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Server configuration error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  const cleanBase = supabaseUrl.replace(/\/+$/, "");
  const encodedPath = encodeURIComponent(objectPath).replace(/%2F/g, "/");
  const endpoint = `${cleanBase}/storage/v1/object/sign/${bucket}/${encodedPath}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceRoleKey}`,
      "apikey": serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase Storage sign error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const signedRelative = data.signedURL || data.signedUrl;
  const fullSignedUrl = signedRelative.startsWith("http")
    ? signedRelative
    : `${cleanBase}${signedRelative.startsWith("/") ? "" : "/"}${signedRelative}`;

  return {
    success: true,
    signedUrl: fullSignedUrl,
    expiresIn,
  };
};

/**
 * Generates a short-lived Supabase signed upload URL (Option A Design).
 */
const generateSupabaseSignedUploadUrl = async (bucket, objectPath) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Server configuration error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  const cleanBase = supabaseUrl.replace(/\/+$/, "");
  const encodedPath = encodeURIComponent(objectPath).replace(/%2F/g, "/");
  const endpoint = `${cleanBase}/storage/v1/object/upload/sign/${bucket}/${encodedPath}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceRoleKey}`,
      "apikey": serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase Storage upload-sign error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const uploadRelative = data.url || data.signedURL || data.signedUrl;
  const fullUploadUrl = uploadRelative.startsWith("http")
    ? uploadRelative
    : `${cleanBase}/storage/v1${
        uploadRelative.startsWith("/") ? "" : "/"
      }${uploadRelative}`;

  return {
    success: true,
    uploadUrl: fullUploadUrl,
    token: data.token,
  };
};

// POST /media/signed-url (or /media/signed-download-url)
const mediaSignedUrlHandler = async (req, res) => {
  const authenticatedUid = req.user.uid;
  const { channelId, objectPath, bucket, expiresIn = 300 } = req.body;

  // Sanitized security audit log (Strictly NO tokens, NO keys logged)
  console.log(`[MEDIA_AUTH] Caller UID: ${authenticatedUid}, Channel: ${channelId || "none"}, Action: signed-url`);

  // 1. Private Bucket Enforcement: only chatter_vault is permitted
  if (bucket && bucket !== "chatter_vault") {
    return res.status(400).json({
      success: false,
      error: "Invalid bucket: Only 'chatter_vault' is allowed for private media operations",
    });
  }
  const targetBucket = "chatter_vault";

  if (!channelId) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameter: channelId is required",
    });
  }

  // 2. Object Path Validation
  const pathValidation = validateObjectPath(objectPath);
  if (!pathValidation.valid) {
    return res.status(400).json({
      success: false,
      error: pathValidation.error,
    });
  }
  const cleanObjectPath = pathValidation.sanitizedPath;

  // 3. Authorization check against channel membership in Firebase RTDB
  const membership = await verifyChannelMembership(authenticatedUid, channelId);
  if (!membership.authorized) {
    if (membership.isWorldChat) {
      return res.status(400).json({
        success: false,
        error: "World Chat media is public and does not require private vault signed URLs",
      });
    }
    return res.status(403).json({
      success: false,
      error: membership.reason || "Forbidden: You are not authorized to access media for this channel",
    });
  }

  try {
    const signResult = await generateSupabaseSignedUrl(targetBucket, cleanObjectPath, Number(expiresIn) || 300);
    return res.status(200).json({
      success: true,
      bucket: targetBucket,
      objectPath: cleanObjectPath,
      signedUrl: signResult.signedUrl,
      expiresIn: signResult.expiresIn,
    });
  } catch (error) {
    console.error("[MEDIA_SIGN_ERROR] Could not generate signed URL:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to generate signed media URL",
    });
  }
};

// POST /media/signed-upload-url (Option A design endpoint)
const mediaSignedUploadUrlHandler = async (req, res) => {
  const authenticatedUid = req.user.uid;
  const { channelId, objectPath, bucket } = req.body;

  console.log(`[MEDIA_AUTH] Caller UID: ${authenticatedUid}, Channel: ${channelId || "none"}, Action: signed-upload-url`);

  // 1. Private Bucket Enforcement: only chatter_vault is permitted
  if (bucket && bucket !== "chatter_vault") {
    return res.status(400).json({
      success: false,
      error: "Invalid bucket: Only 'chatter_vault' is allowed for private media operations",
    });
  }
  const targetBucket = "chatter_vault";

  if (!channelId) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameter: channelId is required",
    });
  }

  // 2. Object Path Validation
  const pathValidation = validateObjectPath(objectPath);
  if (!pathValidation.valid) {
    return res.status(400).json({
      success: false,
      error: pathValidation.error,
    });
  }
  const cleanObjectPath = pathValidation.sanitizedPath;

  // 3. Authorization check against channel membership in Firebase RTDB
  const membership = await verifyChannelMembership(authenticatedUid, channelId);
  if (!membership.authorized) {
    if (membership.isWorldChat) {
      return res.status(400).json({
        success: false,
        error: "World Chat media uses public storage and does not require private vault upload grants",
      });
    }
    return res.status(403).json({
      success: false,
      error: membership.reason || "Forbidden: You are not authorized to upload media for this channel",
    });
  }

  try {
    const uploadResult = await generateSupabaseSignedUploadUrl(targetBucket, cleanObjectPath);
    return res.status(200).json({
      success: true,
      bucket: targetBucket,
      objectPath: cleanObjectPath,
      uploadUrl: uploadResult.uploadUrl,
    });
  } catch (error) {
    console.error("[MEDIA_UPLOAD_SIGN_ERROR] Could not generate upload URL:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to generate signed upload URL",
    });
  }
};

// Endpoints protected with Firebase ID token authentication middleware
app.post("/sendNotification", authenticateUser, sendNotificationHandler);
app.post("/send-notification", authenticateUser, sendNotificationHandler);

// Phase 2 Media Endpoints
app.post("/media/signed-url", authenticateUser, mediaSignedUrlHandler);
app.post("/media/signed-download-url", authenticateUser, mediaSignedUrlHandler);
app.post("/media/signed-upload-url", authenticateUser, mediaSignedUploadUrlHandler);

const PORT = process.env.PORT || 10000;
let serverInstance = null;
if (require.main === module) {
  serverInstance = app.listen(PORT, () => {
    console.log(`KChat Notification & Media Server Running 🚀 on port ${PORT}`);
  });
}

module.exports = {
  app,
  authenticateUser,
  sendNotificationHandler,
  verifyChannelMembership,
  generateSupabaseSignedUrl,
  generateSupabaseSignedUploadUrl,
  mediaSignedUrlHandler,
  mediaSignedUploadUrlHandler,
  getAdminAuth,
  getAdminDb,
  getAdminMessaging,
};
