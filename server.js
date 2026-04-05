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

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ message: "Backend server is running on port 5000! ✅" });
});

app.get("/", (req, res) => {
  res.send('<a href="/auth/google">Login with Google</a>');
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
    // Change this line in your callback route:
    res.redirect(`https://ramana-frontend-automail.vercel.app?refreshToken=${tokens.refresh_token}`);
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).send("Authentication failed");
  }
});

// 3. Send the Email (UPDATED TO ALLOW 10 ATTACHMENTS)
app.post("/send-mail", upload.array("files", 10), async (req, res) => {
  try {
    const { to, cc, bcc, subject, text, refreshToken, userEmail } = req.body;

    const toArray = to.split(",");
    if (toArray.length > 10) {
      return res.status(400).send("Maximum 10 recipients allowed.");
    }

    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const accessToken = await oauth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: userEmail, 
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: refreshToken,
        accessToken: accessToken.token,
      },
    });

    // We process the attachments once before the loop
    const attachments = req.files
      ? req.files.map((file) => ({
          filename: file.originalname,
          content: file.buffer, 
        }))
      : [];

    // THE MAGIC: We loop through the 'toArray' and send a separate email to each person
    const sendPromises = toArray.map(async (recipientEmail) => {
      // .trim() removes any accidental spaces like " email@gmail.com "
      const cleanEmail = recipientEmail.trim(); 
      
      return transporter.sendMail({
        from: userEmail,
        to: cleanEmail, // <--- Now it only sends to THIS specific person
        cc: cc ? cc : "",
        bcc: bcc ? bcc : "",
        subject,
        html: text,
        attachments,
      });
    });

    // Wait for all the individual emails to finish sending concurrently
    await Promise.all(sendPromises);

    res.send("Emails sent individually successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to send email");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
