const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
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
    const allowedExts = [".conf", ".txt", ".zip"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext) || file.mimetype === "text/plain" || file.mimetype === "application/zip") {
      cb(null, true);
    } else {
      cb(new Error("Only .conf, .txt, or .zip files are allowed"));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 },
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

function createTempDir() {
  const dir = path.join(UPLOAD_DIR, `validate-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function findFileInDir(dir, filename) {
  const directPath = path.join(dir, filename);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile && entry.name === filename) {
      return path.join(entry.parentPath || dir, entry.name);
    }
  }
  return null;
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

app.post("/upload/archive", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== ".zip") {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ success: false, message: "Only .zip archives are accepted for this endpoint" });
  }

  const mainFile = (req.body.mainFile || "nginx.conf").trim();
  const tempDir = createTempDir();

  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(tempDir, true);

    const mainFilePath = findFileInDir(tempDir, mainFile);
    if (!mainFilePath) {
      return res.status(400).json({
        success: false,
        message: `Main config file "${mainFile}" not found in archive`,
        availableFiles: listFiles(tempDir),
      });
    }

    const result = await validateNginxConfig(mainFilePath);
    if (result.valid) {
      return res.json({
        success: true,
        message: "Nginx configuration syntax is valid (including all sub-files)",
        detail: result.message,
        mainFile,
      });
    } else {
      return res.status(422).json({
        success: false,
        message: "Nginx configuration syntax is invalid",
        detail: result.message,
        mainFile,
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to process archive or validate nginx configuration",
      detail: err.message,
    });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    removeDir(tempDir);
  }
});

function listFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile) {
        const fullPath = path.join(entry.parentPath || dir, entry.name);
        results.push(path.relative(dir, fullPath).replace(/\\/g, "/"));
      }
    }
  } catch (_) {}
  return results;
}

app.post("/upload/batch", upload.array("files", 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: "No files uploaded" });
  }

  const mainFile = (req.body.mainFile || "nginx.conf").trim();
  const tempDir = createTempDir();

  try {
    let mainFilePath = null;

    for (const file of req.files) {
      const destPath = path.join(tempDir, file.originalname);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.renameSync(file.path, destPath);

      if (file.originalname === mainFile || path.basename(file.originalname) === mainFile) {
        mainFilePath = destPath;
      }
    }

    if (!mainFilePath) {
      mainFilePath = findFileInDir(tempDir, mainFile);
    }

    if (!mainFilePath) {
      return res.status(400).json({
        success: false,
        message: `Main config file "${mainFile}" not found in uploaded files`,
        uploadedFiles: req.files.map((f) => f.originalname),
      });
    }

    const result = await validateNginxConfig(mainFilePath);
    if (result.valid) {
      return res.json({
        success: true,
        message: "Nginx configuration syntax is valid (including all sub-files)",
        detail: result.message,
        mainFile,
        validatedFiles: req.files.map((f) => f.originalname),
      });
    } else {
      return res.status(422).json({
        success: false,
        message: "Nginx configuration syntax is invalid",
        detail: result.message,
        mainFile,
        validatedFiles: req.files.map((f) => f.originalname),
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to validate nginx configuration",
      detail: err.message,
    });
  } finally {
    for (const file of req.files) {
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    removeDir(tempDir);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, message: "File too large (max 10MB)" });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ success: false, message: "Too many files (max 50)" });
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
