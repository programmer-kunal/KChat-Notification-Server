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

// Send push notification endpoint
const sendNotificationHandler = async (req, res) => {
  console.log("========================================");
  console.log(
    "Incoming Notification Request received at:",
    new Date().toISOString()
  );
  console.log("Headers:", req.headers);
  console.log("Body Payload:", JSON.stringify(req.body, null, 2));

  try {
    const { token, topic, title, body, data } = req.body;

    // DATA-ONLY MESSAGE
    // This forces Android to deliver the message to
    // FirebaseMessageService.onMessageReceived()
    const message = {
      data: {
        title: String(title || ""),
        body: String(body || ""),
        senderId: String(data?.senderId || ""),
        channelId: String(data?.channelId || ""),
        senderName: String(data?.senderName || ""),
        senderImage: String(data?.senderImage || ""),
      },

      android: {
        priority: "high",
      },
    };

    // Target selection
    if (token) {
      message.token = token;
      console.log(
        `Routing target configured to Direct Token: ${token}`
      );
    } else if (topic) {
      message.topic = topic.startsWith("/topics/")
        ? topic.replace("/topics/", "")
        : topic;

      console.log(
        `Routing target configured to Topic: ${message.topic}`
      );
    } else {
      throw new Error(
        "Missing recipient target: Either 'token' or 'topic' must be supplied."
      );
    }

    console.log(
      "Constructed DATA-ONLY FCM Payload:"
    );
    console.log(JSON.stringify(message, null, 2));

    const response = await admin.messaging().send(message);

    console.log(
      "Firebase Admin SDK Send Successful! Message ID:",
      response
    );

    res.status(200).json({
      success: true,
      messageId: response,
    });
  } catch (error) {
    console.error(
      "FCM Delivery Pipeline Failed! Error Details:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }

  console.log("========================================\n");
};

// Support both endpoint names
app.post("/sendNotification", sendNotificationHandler);
app.post("/send-notification", sendNotificationHandler);

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`KChat Notification Server Running 🚀 on port ${PORT}`);
});
