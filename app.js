/**
 * File Structed - made with AI
 */
const express = require("express");
const app = express();
const PORT = 3000;

app.use(express.json());

app.use("/auth", require("./routes/auth.routes"));
app.use("/users", require("./routes/user.routes"));
app.use("/games", require("./routes/game.routes"));

app.use((err, req, res, next) => {
  res.status(500).json({
    error: "Server Error",
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
