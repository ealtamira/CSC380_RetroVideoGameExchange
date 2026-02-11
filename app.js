//Made yaml and had ai make api

const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 3000;
const JWT_SECRET = "supersecretkey";

// In-memory storage
let users = [];
let games = [];

/* ===========================
   AUTH MIDDLEWARE
=========================== */

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ===========================
   HATEOAS LINK HELPER
=========================== */

function buildLinks(resource, id) {
  return [
    { rel: "self", href: `/api/v1/${resource}/${id}`, method: "GET" },
    { rel: "update", href: `/api/v1/${resource}/${id}`, method: "PUT" },
    { rel: "delete", href: `/api/v1/${resource}/${id}`, method: "DELETE" }
  ];
}

/* ===========================
   AUTH ROUTES
=========================== */

app.post("/api/v1/auth/register", async (req, res) => {
  const { name, email, password, streetAddress } = req.body;

  if (!name || !email || !password || !streetAddress)
    return res.status(400).json({ error: "Missing required fields" });

  if (users.find(u => u.email === email))
    return res.status(400).json({ error: "Email already exists" });

  const hashed = await bcrypt.hash(password, 10);

  const newUser = {
    id: uuidv4(),
    name,
    email,
    password: hashed,
    streetAddress
  };

  users.push(newUser);

  res.status(201).json({ message: "User created" });
});

app.post("/api/v1/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "1h" });

  res.json({ token });
});

/* ===========================
   USERS
=========================== */

app.get("/api/v1/users/me", authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    streetAddress: user.streetAddress,
    links: buildLinks("users", user.id)
  });
});

app.put("/api/v1/users/me", authenticate, (req, res) => {
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { name, streetAddress } = req.body;
  if (name) user.name = name;
  if (streetAddress) user.streetAddress = streetAddress;

  res.json({ message: "User updated" });
});

app.get("/api/v1/users/:id/games", authenticate, (req, res) => {
  const userExists = users.find(u => u.id === req.params.id);
  if (!userExists) return res.status(404).json({ error: "User not found" });

  const userGames = games.filter(g => g.ownerId === req.params.id);
  res.json(userGames);
});

/* ===========================
   GAMES
=========================== */

app.get("/api/v1/games", authenticate, (req, res) => {
  const { name, system } = req.query;

  let result = [...games];

  if (name) result = result.filter(g => g.name.includes(name));
  if (system) result = result.filter(g => g.system === system);

  res.json(result);
});

app.post("/api/v1/games", authenticate, (req, res) => {
  const { name, publisher, yearPublished, system, condition, previousOwners } = req.body;

  if (!name || !publisher || !yearPublished || !system || !condition)
    return res.status(400).json({ error: "Missing required fields" });

  const newGame = {
    id: uuidv4(),
    name,
    publisher,
    yearPublished,
    system,
    condition,
    previousOwners: previousOwners || 0,
    ownerId: req.user.id,
    links: []
  };

  newGame.links = buildLinks("games", newGame.id);

  games.push(newGame);

  res.status(201).json(newGame);
});

app.get("/api/v1/games/:id", authenticate, (req, res) => {
  const game = games.find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  res.json(game);
});

app.put("/api/v1/games/:id", authenticate, (req, res) => {
  const game = games.find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (game.ownerId !== req.user.id)
    return res.status(403).json({ error: "Not game owner" });

  Object.assign(game, req.body);

  res.json({ message: "Game updated" });
});

app.delete("/api/v1/games/:id", authenticate, (req, res) => {
  const index = games.findIndex(g => g.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Game not found" });

  if (games[index].ownerId !== req.user.id)
    return res.status(403).json({ error: "Not game owner" });

  games.splice(index, 1);

  res.status(204).send();
});

/* ===========================
   START SERVER
=========================== */

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/api/v1`);
});
