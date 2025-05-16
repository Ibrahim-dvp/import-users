const express = require("express");
const multer = require("multer");
const cors = require("cors");
const admin = require("firebase-admin");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");

const app = express();

// built-in body parsers (won't touch multipart)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ensure our base upload directories exist
const UPLOADS_ROOT = path.join(__dirname, "uploads");
const SERVICE_DIR = path.join(UPLOADS_ROOT, "serviceAccounts");
const CSV_DIR = path.join(UPLOADS_ROOT, "csv");

for (const dir of [UPLOADS_ROOT, SERVICE_DIR, CSV_DIR]) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

// ─── Multer storage configs ──────────────────────────────────────────
// 1) service account JSON → uploads/serviceAccounts/<projectId>.json
const serviceAccountStorage = multer.diskStorage({
	destination: (req, file, cb) => cb(null, SERVICE_DIR),
	filename: (req, file, cb) => {
		const projectId = req.body.project_id;
		if (!projectId) return cb(new Error("Missing project_id"));
		cb(null, `${projectId}.json`);
	},
});
const uploadServiceAccount = multer({
	storage: serviceAccountStorage,
	fileFilter: (req, file, cb) => {
		if (file.mimetype !== "application/json") {
			return cb(new Error("Only JSON service-account files allowed"));
		}
		cb(null, true);
	},
	limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// 2) CSVs → uploads/csv/<timestamp>_<originalname>
const csvStorage = multer.diskStorage({
	destination: (req, file, cb) => cb(null, CSV_DIR),
	filename: (req, file, cb) => {
		const ts = Date.now();
		const name = file.originalname.replace(/\s+/g, "_");
		cb(null, `${ts}_${name}`);
	},
});
const uploadCsv = multer({
	storage: csvStorage,
	fileFilter: (req, file, cb) => {
		if (!file.originalname.match(/\.csv$/)) {
			return cb(new Error("Only CSV files allowed"));
		}
		cb(null, true);
	},
	limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ─── Helper to initialize / reuse a Firebase app ─────────────────────
function getOrInitAdmin(projectId, keyPath) {
	const name = `fb-${projectId}`;
	let fbApp = admin.apps.find((a) => a.name === name);
	if (!fbApp) {
		const svc = JSON.parse(fs.readFileSync(keyPath, "utf8"));
		fbApp = admin.initializeApp(
			{
				credential: admin.credential.cert(svc),
				databaseURL: `https://${projectId}.firebaseio.com`,
			},
			name
		);
	}
	return fbApp;
}

// ─── Route: upload / overwrite service‐account JSON ─────────────────
app.post(
	"/api/store-service-account",
	uploadServiceAccount.single("credentials_file"),
	(req, res) => {
		// multer has already saved the file and populated req.body
		if (!req.file) {
			return res.status(400).json({ error: "No file uploaded" });
		}
		return res.json({
			success: true,
			message: `Saved ${req.file.filename}`,
			body: req.body,
		});
	}
);

// ─── Route: bulk import users via CSV ────────────────────────────────
app.post(
	"/api/import-users",
	uploadCsv.single("csv_file"),
	async (req, res) => {
		try {
			const { target_project_id } = req.body;

			if (!req.file)
				return res.status(400).json({ error: "CSV file is required" });
			if (!target_project_id)
				return res.status(400).json({ error: "target_project_id is required" });

			const keyFile = path.join(SERVICE_DIR, `${target_project_id}.json`);
			if (!fs.existsSync(keyFile)) {
				return res
					.status(404)
					.json({ error: `No service account for project ${target_project_id}` });
			}

			const firebaseApp = getOrInitAdmin(target_project_id, keyFile);
			const auth = firebaseApp.auth();

			const users = [];
			await new Promise((resolve, reject) => {
				fs
					.createReadStream(req.file.path)
					.pipe(csv())
					.on("data", (row) => {
						users.push({
							uid: row.uid,
							email: row.email,
							emailVerified: row.emailVerified === "true",
							passwordHash: Buffer.from(row.passwordHash, "base64"),
							passwordSalt: Buffer.from(row.passwordSalt, "base64"),
						});
					})
					.on("end", resolve)
					.on("error", reject);
			});

			const results = [];
			for (let i = 0; i < users.length; i += 1000) {
				const batch = users.slice(i, i + 1000);
				const result = await auth.importUsers(batch, {
					hash: {
						algorithm: "HMAC_SHA256", // use your correct hash algorithm
						key: Buffer.from("secretKey"), // replace with real key used to hash passwords
					},
				});
				results.push({
					batch: Math.floor(i / 1000) + 1,
					success: result.successCount,
					failed: result.failureCount,
					errors: result.errors,
				});
			}

			fs.unlinkSync(req.file.path);

			return res.json({
				success: true,
				totalImported: users.length,
				report: results,
			});
		} catch (err) {
			console.error(err);
			return res.status(500).json({ error: err.message });
		}
	}
);

// ─── Global error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
	console.error("Unhandled error:", err);
	res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server listening on port ${PORT}`);
});
