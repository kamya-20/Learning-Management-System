const express = require("express");
const path = require("path");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { v2: cloudinary } = require("cloudinary");
const mongoose = require("mongoose");
const fs = require("fs");
const ejsMate = require("ejs-mate");
const dotenv = require("dotenv");
const { encrypt, decrypt } = require("./utils/crypto");
const bcrypt = require("bcrypt");
const session = require("express-session");
const bodyParser = require("body-parser");
const userModel = require("./models/user");
const adminModel = require("./models/admin");
const videoModel = require("./models/video");
const feedbackModel = require("./models/feedback");
const MongoStore = require("connect-mongo");
const app = express();
const cookieParser = require("cookie-parser");
const { URLSearchParams } = require("url");
const PORT = process.env.PORT || 5000;
const { isAuthenticated } = require("./middleware.js");
const flash = require("flash");
const puppeteer = require("puppeteer");
dotenv.config();

// ===== Cloudinary Configuration =====
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Mongodb connected"))
  .catch((err) => console.log("Error connecting mongodb", err));

// Multer setup
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

const KEY = process.env.PW_SECRET_KEY; // must be 32 bytes base64 or hex (see below)

// helper to ensure key format
if (!KEY) {
  throw new Error("Set PW_SECRET_KEY env var (32 bytes base64 string).");
}
app.use(express.static("public"));

app.use(express.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.engine("ejs", ejsMate);
app.use(express.static(path.join(__dirname, "public")));

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath); // add this line too

// app.use(
//   session({
//     secret: process.env.SESSION_SECRET,
//     resave: false,
//     saveUninitialized: false,
//     store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
//     cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
//   })
// );

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
      ttl: 14 * 24 * 60 * 60, // 14 days
    }),
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  }),
);

app.use(async (req, res, next) => {
  // res.locals.success = req.flash("success");
  // res.locals.error = req.flash("error");
  res.locals.currUser = req.user;
  next();
});

app.get("/", (req, res) => {
  res.render("layouts/boilerplate.ejs", { page: "home" });
});

const admins = [
  {
    uniqueId: process.env.ADMIN1_ID,
    password: process.env.ADMIN1_PASSWORD,
    name: process.env.ADMIN1_NAME,
    role: "admin",
  },
  {
    uniqueId: process.env.ADMIN2_ID,
    password: process.env.ADMIN2_PASSWORD,
    name: process.env.ADMIN2_NAME,
    role: "admin",
  },
];

app.post("/logout", (req, res) => {
  console.log("logging out");
  req.session.destroy(() => res.redirect("/"));
});

const addFeedback = async (course, userId, rating, content, comments) => {
  const feedback = new feedbackModel({
    course,
    userId,
    rating,
    content,
    comments,
  });
  await feedback.save();
  console.log("Feedback added successfully!");
};

// ===== ROUTES =====

app.get("/login", (req, res) => {
  res.render("users/login.ejs", { page: "login" });
});

app.get("/signup", (req, res) => {
  res.render("users/signup.ejs", { page: "signup" });
});

app.get("/", (req, res) => {
  res.render("includes/landing.ejs", { page: "home" });
});

// app.get("/show_certificate", (req, res) => {
//   res.render("includes/show_certificate.ejs", { page: "show_certificate" });
// });

app.get("/feedback", (req, res) => {
  res.render("includes/feedback.ejs", { page: "feedback" });
});

// Admin Dashboard
app.get("/admin/dashboard", async (req, res) => {
  try {
    const videos = await videoModel.find().sort({ createdAt: -1 }); // latest first
    const totalVideos = videos.length;
    const totalCourses = await videoModel.distinct("course");

    res.render("includes/admin_dashboard", { page: "admindashboard", videos, totalCourses, totalVideos });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

//Delete Video
app.post("/video/delete/:id", async (req, res) => {
  try {
    await videoModel.findByIdAndDelete(req.params.id);
    res.redirect("/admin/dashboard");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

app.get("/video_upload", async (req, res) => {
  try {
    // Fetch all unique course names from DB
    const courses = await videoModel.distinct("course");

    // Render page with dynamic courses
    res.render("includes/video_upload", {
      page: "video_upload",
      courses, // pass this to EJS
    });
  } catch (err) {
    console.error("Error loading courses:", err);
    res.status(500).send("Failed to load upload page");
  }
});

app.get("/courses", async (req, res) => {
  try {
    // 🔸 Check if user is logged in
    if (!req.session.user) {
      return res.redirect("/login");
    }
    const userId = req.session.user.id;

    // 1️⃣ Get user and all videos
    const user = await userModel.findOne({ enrollmentId: req.session.user.id });

    const allCourses = await videoModel.distinct("course");
    const coursesWithProgress = [];

    // 2️⃣ For each course, calculate progress
    for (const courseName of allCourses) {
      console.log(`\n➡️ Calculating progress for course: ${courseName}`);
      const totalVideos = await videoModel.countDocuments({ course: courseName });

      // find all videoIds belonging to this course
      const courseVideos = await videoModel.find({ course: courseName }).select("_id");

      // count how many of these are in user.watchedVideos
      const watchedCount = user.watchedVideos.filter((w) => courseVideos.some((v) => v._id.toString() === w.videoId.toString())).length;

      const progress = totalVideos > 0 ? Math.round((watchedCount / totalVideos) * 100) : 0;
      console.log("📈 Progress:", progress, "%");
      coursesWithProgress.push({ title: courseName, progress });
    }

    // Render template with courses array
    res.render("includes/courses", {
      page: "courses",
      courses: coursesWithProgress,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

app.get("/about_us", (req, res) => {
  res.render("includes/about_us", { page: "about_us" });
});

app.get("/help", (req, res) => {
  res.render("includes/help", { page: "help" });
});

app.get("/developed_by", (req, res) => {
  res.render("includes/developed_by", { page: "developed_by" });
});

app.post("/upload-video", upload.single("video"), async (req, res) => {
  try {
    const { topic, course, newCourse, description, summary } = req.body;
    const videoPath = req.file.path;
    const thumbnailPath = `uploads/thumb-${Date.now()}.png`;

    // If "New Course" selected
    const finalCourse = course === "new" ? newCourse : course;

    // Generate thumbnail using ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on("end", resolve)
        .on("error", reject)
        .screenshots({
          count: 1,
          folder: "uploads",
          filename: path.basename(thumbnailPath),
          size: "320x240",
        });
    });

    // Upload to Cloudinary
    const videoUpload = await cloudinary.uploader.upload(videoPath, {
      resource_type: "video",
      folder: "lms_videos",
    });

    const thumbUpload = await cloudinary.uploader.upload(thumbnailPath, {
      folder: "lms_thumbnails",
    });

    // Save in MongoDB
    const newVideo = await videoModel.create({
      topic,
      course: finalCourse,
      description,
      summary,
      videoUrl: videoUpload.secure_url,
      thumbnailUrl: thumbUpload.secure_url,
    });

    // Clean up local temp files
    fs.unlinkSync(videoPath);
    fs.unlinkSync(thumbnailPath);

    res.redirect("/admin/dashboard"); // redirect to videos page after upload
  } catch (err) {
    console.error(err);
    res.status(500).send("Upload failed");
  }
});

app.get("/course/:courseName", async (req, res) => {
  try {
    const courseName = decodeURIComponent(req.params.courseName);

    // get all videos of that course
    const videos = await videoModel.find({ course: courseName }).sort({ createdAt: 1 });

    // check which video is selected
    const selectedVideoId = req.query.v;
    const currentVideo = selectedVideoId ? await videoModel.findById(selectedVideoId) : videos[0]; // default = first video

    res.render("includes/show", { page: "show", videos, currentVideo, courseName });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading course videos");
  }
});

app.post("/watch/:videoId", async (req, res) => {
  try {
    // ✅ 1. Check if user is logged in
    if (!req.session.user) return res.status(401).send("Login required");

    // ✅ 2. Get videoId and enrollmentId from session
    const videoId = req.params.videoId;
    const enrollmentId = req.session.user.id; // this is enrollmentId stored in session
    console.log("🎥 Video ID:", videoId);

    // ✅ 3. Find user by enrollmentId (not _id)
    const user = await userModel.findOne({ enrollmentId });

    if (!user) return res.status(404).send("User not found");

    // ✅ 4. Log current watchedVideos
    console.log(" Current watchedVideos:", user.watchedVideos);
    // ✅ 4. Prevent duplicate entries
    const alreadyWatched = user.watchedVideos.some((v) => v.videoId.toString() === videoId);

    if (!alreadyWatched) {
      user.watchedVideos.push({ videoId });
      await user.save();
    }

    res.status(200).send("Progress updated");
  } catch (err) {
    console.error("Error updating progress:", err);
    res.status(500).send("Error updating progress");
  }
});

//---USER DASHBOARD---

app.get("/userdashboard", async (req, res) => {
  try {
    // 🔸 Check if user is logged in
    if (!req.session.user) {
      return res.redirect("/login");
    }

    // 🔸 Fetch the logged-in user's data from DB if needed
    const user = await userModel.findOne({ enrollmentId: req.session.user.id }).populate("watchedVideos.videoId");
    // Get unique course names from all videos
    const courses = await videoModel.distinct("course");

    const progressData = {};
    const courseThumbnails = {};

    let completedCourses = 0; // ✅ NEW
    let totalStudyVideos = 0; // helper for study hours

    for (const course of courses) {
      const firstVideo = await videoModel.findOne({ course });
      courseThumbnails[course] = firstVideo?.thumbnailUrl || "";

      const total = await videoModel.countDocuments({ course });

      const watched = user.watchedVideos.filter((v) => v.videoId?.course === course).length;

      const progress = total > 0 ? Math.round((watched / total) * 100) : 0;
      progressData[course] = progress;

      //  Count completed courses
      if (progress === 100) {
        completedCourses++;
      }

      // Count total watched videos
      totalStudyVideos += watched;
    }

    //  Certificates (1 per completed course)
    const certificatesEarned = completedCourses;

    //  Study Hours (assumption: 1 video = 30 mins)
    const studyHours = Math.round((totalStudyVideos * 30) / 60);

    res.render("includes/user_dashboard.ejs", {
      page: "userdashboard",
      courses,
      courseThumbnails,
      user,
      progressData,
      completedCourses,
      certificatesEarned,
      studyHours,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dashboard");
  }
});

//CERTIFICATE PAGE
app.get("/certificates", async (req, res) => {
  try {
    if (!req.session.user) return res.redirect("/login");

    const user = await userModel.findOne({ enrollmentId: req.session.user.id }).populate("watchedVideos.videoId");

    const courses = await videoModel.distinct("course");
    const completedCourses = [];

    for (const course of courses) {
      const total = await videoModel.countDocuments({ course });
      const watched = user.watchedVideos.filter((v) => v.videoId?.course === course).length;
      const progress = total > 0 ? Math.round((watched / total) * 100) : 0;

      // ✅ Only push fully completed courses
      if (progress === 100) {
        completedCourses.push({
          title: course,
          progress,
        });
      }
    }

    res.render("includes/certificates", {
      page: "certificates",
      user,
      completedCourses,
    });
  } catch (error) {
    console.error("Error loading certificates:", error);
    res.status(500).send("Server Error");
  }
});

app.get("/show_certificate", async (req, res) => {
  try {
    const { course, name, batch, enrollmentId } = req.query;

    let user = null;

    // Try to get user from session if available
    if (req.session?.user?.id) {
      user = await userModel.findOne({ enrollmentId: req.session.user.id });
    }

    // If no session user found, use query-based fallback
    if (!user) {
      user = {
        name: name || "Student",
        batch: batch || "Batch",
        enrollmentId: enrollmentId || "Enrollment",
      };
    }

    const courseName = course || "Course";

    res.render("includes/show_certificate", {
      page: "show_certificate",
      user,
      courseName,
    });
  } catch (err) {
    console.error("❌ Error rendering certificate:", err);
    res.status(500).send("Failed to render certificate page");
  }
});

// SIGNUP
app.post("/signup", async (req, res) => {
  try {
    const { name, enrollmentId, password, collegeName, batch } = req.body;

    if (!enrollmentId || !password) return res.status(400).send("password and enrollmentID required");

    const existing = await userModel.findOne({ enrollmentId });
    if (existing) return res.status(400).send("User already registered");

    const passwordHash = await bcrypt.hash(password, 10);
    const passwordEncrypted = encrypt(password);

    const user = await userModel.create({ name, enrollmentId, passwordHash, passwordEncrypted, collegeName, batch });

    // res.status(201).json({ message: "Registered", userId: user._id });
    res.redirect("/showuser");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

//LOGIN
app.post("/login", async (req, res) => {
  const { uniqueId, password } = req.body;

  // 1️⃣ Check if admin (from .env)
  const admin = admins.find((a) => a.uniqueId === uniqueId && a.password === password);

  if (admin) {
    req.session.user = {
      id: admin.uniqueId,
      name: admin.name,
      role: admin.role,
    };
    return res.redirect("/admin/dashboard");
  }

  // 2️⃣ Else check MongoDB user
  const user = await userModel.findOne({ enrollmentId: uniqueId });
  if (!user) {
    return res.status(401).render("users/login", { error: "User not found", values: { uniqueId }, page: "login" });
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    return res.status(401).render("users/login", { error: "Incorrect password", values: { uniqueId }, page: "login" });
  }

  // success
  req.session.user = {
    id: user.enrollmentId,
    name: user.name,
    role: user.role || "user",
  };

  res.redirect("/userdashboard");
  // res.render("includes/user_dashboard.ejs", { page: "userdashboard",user });
});

app.get("/showuser", async (req, res) => {
  try {
    const users = await userModel.find().lean();

    // decrypt passwords for each user
    const usersWithPlaintext = users.map((user) => {
      const decryptedPassword = decrypt(user.passwordEncrypted);
      return { ...user, plaintextPassword: decryptedPassword };
    });

    res.render("includes/showuser.ejs", {
      page: "showuser",
      users: usersWithPlaintext,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).send("Server Error");
  }
});

// Delete a user from showuser page
app.post("/deleteuser/:id", async (req, res) => {
  try {
    await userModel.findByIdAndDelete(req.params.id);
    res.redirect("/showuser");
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).send("Server Error");
  }
});

app.get("/profile", async (req, res) => {
  try {
    // ✅ 1. Check if user is logged in
    if (!req.session.user) {
      return res.redirect("/login");
    }

    // ✅ 2. Get user ID from session
    const userId = req.session.user.id;

    // ✅ 3. Fetch user details using correct field name
    const user = await userModel.findOne({ enrollmentId: userId }).lean();

    if (!user) {
      return res.status(404).render("includes/profile", {
        layout: "layouts/boilerplate",
        title: "Profile",
        user: null,
        message: "User not found",
        page: "profile",
      });
    }

    // ✅ 4. Render EJS with user data
    res.render("includes/profile", {
      user,
      page: "profile",
    });
  } catch (err) {
    console.error("Profile route error:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/feedback", async (req, res) => {
  try {
    let course = req.query.course;
    if (!course) return res.status(400).send("Course name missing");

    const sessionUser = req.session.user;
    if (!sessionUser) return res.redirect("/login");

    const userId = sessionUser.id; // because session stores id
    // const userName = sessionUser.name;
    // 🔥 Normalize same way
    course = course.trim().toLowerCase();

    const existingFeedback = await feedbackModel.findOne({
      userId: userId,
      courseName: course,
    });

    if (existingFeedback) {
      console.log("⚡ Feedback already exists, redirecting...");
      return res.redirect(`/show_certificate?course=${encodeURIComponent(course)}`);
    }

    res.render("feedback", {
      courseName: course,
      userName: sessionUser.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/feedback/submit", async (req, res) => {
  try {
    let { courseName, rating, contentFeedback, instructorFeedback, recommend } = req.body;
    const sessionUser = req.session.user;
    if (!sessionUser) return res.redirect("/login");

    const userId = sessionUser.id; // enrollmentId

    courseName = courseName.trim().toLowerCase();

    const existingFeedback = await feedbackModel.findOne({
      userId: userId,
      courseName,
    });

    if (!existingFeedback) {
      await feedbackModel.create({
        userId: userId,
        courseName,
        rating: Number(rating),
        contentFeedback,
        instructorFeedback,
        recommend,
      });

      console.log("✅ Feedback saved!");
    }

    return res.redirect(`/show_certificate?course=${encodeURIComponent(courseName)}`);
  } catch (err) {
    console.error("❌ Error saving feedback:", err);
    res.status(500).send("Failed to save feedback");
  }
});

app.get("/download_certificate_image", async (req, res) => {
  try {
    const course = req.query.course;
    if (!course) return res.status(400).send("Course name missing");

    // ✅ Use session data safely
    const userName = req.session.user?.name || req.query.name || "Student";
    const userBatch = req.session.user?.batch || req.query.batch || "Batch";
    const userEnroll = req.session.user?.id || req.query.enrollmentId || "Enrollment";

    const baseUrl = process.env.BASE_URL || "http://localhost:8080";

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--single-process", "--no-zygote"],
    });

    const page = await browser.newPage();

    // ✅ Load the actual certificate page
    const targetUrl = `${baseUrl}/show_certificate?course=${encodeURIComponent(course)}&name=${encodeURIComponent(userName)}&batch=${encodeURIComponent(userBatch)}&enrollmentId=${encodeURIComponent(userEnroll)}`;

    console.log("🎓 Generating certificate for:", targetUrl);

    await page.goto(targetUrl, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1200)); // allow time for fonts/images

    // ✅ Run script *after* page is loaded
    await page.evaluate(() => {
      document.body.classList.add("download-mode");
    });

    const cert = await page.$(".certificate-container");
    if (!cert) throw new Error("Certificate container not found on page.");

    const imageBuffer = await cert.screenshot({ type: "png", omitBackground: false });
    await browser.close();

    res.setHeader("Content-Disposition", `attachment; filename="${userName}-${course}-Certificate.png"`);
    res.contentType("image/png");
    res.send(imageBuffer);
  } catch (err) {
    console.error("❌ Error generating certificate image:", err);
    res.status(500).send("Failed to generate certificate image");
  }
});

app.listen(PORT, () => {
  console.log("server is listening to port 8080");
});
