const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

// Load Firebase service account from Render environment variable
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.get("/", (req, res) => {
  res.send("KChat Notification Server Running 🚀");
});

// Send push notification endpoint (handles both /sendNotification and /send-notification safely)
const sendNotificationHandler = async (req, res) => {
  console.log("========================================");
  console.log("Incoming Notification Request received at:", new Date().toISOString());
  console.log("Headers:", req.headers);
  console.log("Body Payload:", JSON.stringify(req.body, null, 2));

  try {
    const { token, topic, title, body, data } = req.body;

    // Build standard FCM v1 message structure
    const message = {};

    // 1. Add notification visual fields
    if (title || body) {
      message.notification = {
        title: title || "",
        body: body || "",
      };
    }

    // 2. Add custom data payloads (crucial for client-side routing & filters)
    if (data) {
      message.data = {};
      // Ensure all keys are strings (Firebase Admin SDK expects string values for data payload)
      Object.keys(data).forEach((key) => {
        message.data[key] = String(data[key]);
      });
    }

    // 3. Set routing target (token or topic)
    if (token) {
      message.token = token;
      console.log(`Routing target configured to Direct Token: ${token}`);
    } else if (topic) {
      // If a full topic name was passed, use it; otherwise format it (e.g., direct string match)
      message.topic = topic.startsWith("/topics/") ? topic.replace("/topics/", "") : topic;
      console.log(`Routing target configured to Topic: ${message.topic}`);
    } else {
      throw new Error("Missing recipient target: Either 'token' or 'topic' must be supplied.");
    }

    console.log("Constructed FCM Message Payload for SDK:", JSON.stringify(message, null, 2));

    // Send the message via Firebase Admin SDK
    const response = await admin.messaging().send(message);
    console.log("Firebase Admin SDK Send Successful! Message ID:", response);

    res.status(200).json({
      success: true,
      messageId: response,
    });

  } catch (error) {
    console.error("FCM Delivery Pipeline Failed! Error Details:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
  console.log("========================================\n");
};

// Listen on both naming variants for robust client integration
app.post("/sendNotification", sendNotificationHandler);
app.post("/send-notification", sendNotificationHandler);
