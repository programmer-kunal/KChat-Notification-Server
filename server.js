require("dotenv").config();
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
  res.send("KChat Notification Server Running 🚀");
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
        channelId: String(data?.channelId || ""),
        senderName: String(data?.senderName || ""),
        senderImage: String(data?.senderImage || ""),
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

// Endpoints protected with Firebase ID token authentication middleware
app.post("/sendNotification", authenticateUser, sendNotificationHandler);
app.post("/send-notification", authenticateUser, sendNotificationHandler);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`KChat Notification Server Running 🚀 on port ${PORT}`);
});

module.exports = { app, authenticateUser, sendNotificationHandler, getAdminAuth, getAdminDb, getAdminMessaging };
