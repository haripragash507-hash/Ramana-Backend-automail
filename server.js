require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const multer = require("multer");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Helper function to smartly extract "Name <email>" from messy strings
const extractEmails = (inputStr) => {
  if (!inputStr) return [];
  // This regex grabs standard emails OR correctly formatted "Name <email>" pairs
  const matches = inputStr.match(/(?:[^<,\n]+<[^>]+>)|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
  return matches ? matches.map((email) => email.trim()) : [];
};

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ message: "Backend server is running on port 5000! ✅" });
});

app.get("/login", (req, res) => {
  res.send('<a href="/auth/url">Login with Google</a>');
});

// 1. Generate the Google Login URL
app.get("/auth/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://mail.google.com/"],
    prompt: "consent",
  });
  res.json({ url });
});

// 2. Handle the Google Callback
app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // Redirect back to React with the token in the URL
    res.redirect(`https://ramana-frontend-automail.vercel.app?refreshToken=${tokens.refresh_token}`);
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).send("Authentication failed");
  }
});

// 3. Send the Email (UPDATED WITH PROPER NAME FORMATTING)
app.post("/send-mail", upload.array("files", 10), async (req, res) => {
  try {
    // Added 'userName' here so you can pass the Sender's name from the frontend
    const { to, cc, bcc, subject, text, refreshToken, userEmail, userName } = req.body;

    // Use the smart extractor to handle the mixed formatting in your provided list
    const toArray = extractEmails(to);
    
    if (toArray.length > 10) {
      return res.status(400).send("Maximum 10 recipients allowed.");
    }

    // Authenticate with Google
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    
    // Initialize the Gmail HTTP API
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const attachments = req.files
      ? req.files.map((file) => ({
          filename: file.originalname,
          content: file.buffer, 
        }))
      : [];

    const transporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true 
    });

    // Format the FROM field (e.g., "Ramana" <ramana@example.com>)
    const fromField = userName ? `"${userName}" <${userEmail}>` : userEmail;
    
    // Clean up CC and BCC fields using the same smart extractor
    const cleanedCc = extractEmails(cc).join(", ");
    const cleanedBcc = extractEmails(bcc).join(", ");

    // Loop through the recipients
    const sendPromises = toArray.map(async (recipientEmail) => {
      
      const mailOptions = {
        from: fromField,             // Will show Sender Name + Email
        to: recipientEmail,          // Will show Recipient Name + Email
        cc: cleanedCc,               // Will show CC Names + Emails
        bcc: cleanedBcc,             // Will show BCC Names + Emails
        subject,
        html: text,
        attachments,
      };

      // 1. Build the raw email buffer using Nodemailer
      const info = await transporter.sendMail(mailOptions);
      
      // 2. Convert the buffer to base64url format
      const encodedMessage = info.message.toString("base64")
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      // 3. Send using standard HTTP via the Gmail API
      return gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedMessage,
        },
      });
    });

    // Wait for all the individual emails to finish sending concurrently
    await Promise.all(sendPromises);

    res.send("Emails sent successfully!");
  } catch (err) {
    console.error("Mail send error:", err);
    res.status(500).send("Failed to send email");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
