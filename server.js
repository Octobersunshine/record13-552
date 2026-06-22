const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith(".conf") || file.mimetype === "text/plain") {
      cb(null, true);
    } else {
      cb(new Error("Only .conf or text files are allowed"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

function validateNginxConfig(filePath) {
  return new Promise((resolve) => {
    execFile("nginx", ["-t", "-c", filePath], (error, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      if (error) {
        resolve({ valid: false, message: output.trim() || error.message });
      } else {
        resolve({ valid: true, message: output.trim() });
      }
    });
  });
}

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  const filePath = req.file.path;

  try {
    const result = await validateNginxConfig(filePath);
    if (result.valid) {
      return res.json({
        success: true,
        message: "Nginx configuration syntax is valid",
        detail: result.message,
        filename: req.file.originalname,
      });
    } else {
      return res.status(422).json({
        success: false,
        message: "Nginx configuration syntax is invalid",
        detail: result.message,
        filename: req.file.originalname,
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to validate nginx configuration",
      detail: err.message,
    });
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, message: "File too large (max 5MB)" });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
