const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
  {
    courseName: {
      type: String,
      required: true,
      trim: true,
    },
    userId: {
      type: String,
      required: true,
    },

    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    contentFeedback: {
      type: String,
      required: true,
      enum: ["Very Comprehensive", "Well Structured", "Average", "Needs Improvement", "Not Useful"],
    },

    instructorFeedback: {
      type: String,
      required: true,
      enum: ["Excellent", "Very Good", "Good", "Fair", "Poor"],
    },

    recommend: {
      type: String,
      required: true,
      enum: ["Definitely Yes", "Probably Yes", "Not Sure", "Probably Not", "Definitely Not"],
    },
  },
  { timestamps: true }, // createdAt & updatedAt automatically add ho jayega
);
// 🔥 Prevent duplicate feedback per user per course
feedbackSchema.index({ userId: 1, courseName: 1 }, { unique: true });
module.exports = mongoose.model("feedback", feedbackSchema);
