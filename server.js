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

// ---------------------------------------------------------
// 1. THE ADDRESS BOOK (Hardcoded Known Contacts)
// ---------------------------------------------------------
const knownContacts = {
  "ravinasri@jozuna.com": "Ravina Sri",
  "hemamalini.srinivasan@jozuna.com": "Hemamalini Srinivasan",
  "kasheer.eswaran@jozuna.com": "Kasheer Eswaran",
  "shradha@jozuna.com": "Shradha Agarwal",
  "logarachaka.m@jozuna.com": "Logarachaka M",
  "sree.krishnan@jozuna.com": "Sree Krishnan",
  "sudir.senthil2@gmail.com": "Sudir Senthil",
  "haripragash507@gmail.com": "Hari Pragash",
  "haripragash85@gmail.com" : " Hari Pragash A",
};

// ---------------------------------------------------------
// 2. THE SMART GUESSER + DICTIONARY LOOKUP
// ---------------------------------------------------------
const extractEmails = (inputStr) => {
  if (!inputStr) return [];
  
  // Grab standard emails OR correctly formatted "Name <email>" pairs
  const matches = inputStr.match(/(?:[^<,\n]+<[^>]+>)|(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
  if (!matches) return [];

  return matches.map((match) => {
    const cleanMatch = match.trim();
    
    // Extract just the raw email address so we can look it up in the dictionary
    const rawEmailMatch = cleanMatch.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (!rawEmailMatch) return cleanMatch;
    
    // Convert to lowercase so it always matches our dictionary perfectly
    const rawEmail = rawEmailMatch[0].toLowerCase(); 

    // EXACT DICTIONARY MATCH
    if (knownContacts[rawEmail]) {
      return `"${knownContacts[rawEmail]}" <${rawEmail}>`;
    }

    // PREVIOUS LOGIC (If not in dictionary)
    if (cleanMatch.includes('<') && cleanMatch.includes('>')) {
      return cleanMatch;
    } 
    
    // If it's a completely unknown raw email, guess the name from the prefix
    const emailPrefix = rawEmail.split('@')[0];
    
    // Remove all numeric digits from the prefix
    let textOnlyPrefix = emailPrefix.replace(/[0-9]/g, '');
    
    // Fallback: If the email was literally ONLY numbers
    if (textOnlyPrefix.trim() === '') {
      textOnlyPrefix = 'User';
    }
    
    // Split by dots, underscores, or hyphens, remove empty spaces, and capitalize
    const guessedName = textOnlyPrefix
      .split(/[._-]/)
      .filter(word => word.length > 0) 
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
      
    // Return the perfectly formatted string for nodemailer
    return `"${guessedName}" <${rawEmail}>`;
  });
};
// ---------------------------------------------------------

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

// 3. Send the Email
app.post("/send-mail", upload.array("files", 10), async (req, res) => {
  try {
    const { to, cc, bcc, subject, text, refreshToken, userEmail, userName } = req.body;

    // Use the smart extractor to handle the mixed formatting and guess/lookup names
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

    // Format the FROM field
    const fromField = userName ? `"${userName}" <${userEmail}>` : userEmail;
    
    // Clean up CC and BCC fields using the same smart extractor
    const cleanedCc = extractEmails(cc).join(", ");
    const cleanedBcc = extractEmails(bcc).join(", ");

    // Loop through the recipients
    const sendPromises = toArray.map(async (recipientEmail) => {
      
      const mailOptions = {
        from: fromField,             
        to: recipientEmail,          
        cc: cleanedCc,               
        bcc: cleanedBcc,             
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
      
