//Made yaml and had ai make api
require("dotenv").config();

const express = require("express");
const client = require('prom-client'); //
const register = new client.Registry(); //
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const PORT = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/gamedb";
const app = express();
const jwtSecret = process.env.JWT_SECRET || 'supersecretkey';
app.use(express.json());
app.use(cors());

/* ===========================
   REDIS CACHE (The Enhancement)
=========================== */
const { createClient } = require('redis');

const redisClient = createClient({
  url: 'redis://redis:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

async function connectRedis() {
  try {
    await redisClient.connect();
    console.log("Connected to Redis distributed cache");
  } catch (err) {
    console.error("Redis connection failed:", err);
  }
}
connectRedis();

/* ===========================
   PROMETHEUS MONITORING
=========================== */

// 1. Collect default metrics (CPU, Memory, etc.)
client.collectDefaultMetrics({ register }); //

// 2. Custom Metric: Track HTTP requests by path and status
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status']
});
register.registerMetric(httpRequestCounter); //

// 3. Custom Metric: Track Kafka messages produced
const kafkaProducerCounter = new client.Counter({
  name: 'kafka_messages_produced_total',
  help: 'Total Kafka messages sent from API',
  labelNames: ['event_type']
});
register.registerMetric(kafkaProducerCounter); //

// Middleware to track requests automatically
app.use((req, res, next) => {
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    httpRequestCounter.labels(req.method, route, res.statusCode).inc();
  });
  next();
});

// 4. The /metrics endpoint for Prometheus to scrape
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}); //

/* ===========================
   Kafka producer
=========================== */

const { Kafka } = require("kafkajs");

const kafka = new Kafka({
  clientId: "game-api",
  brokers: ["kafka:29092"],
});

const producer = kafka.producer();

async function initKafka() {
  const admin = kafka.admin();
  try {
    await admin.connect();
    console.log("Kafka Admin connected");
    const topics = await admin.listTopics();
    if (!topics.includes("user")) {
      await admin.createTopics({
        topics: [{
          topic: "user",
          numPartitions: 1,
          replicationFactor: 1,
        }],
      });
      console.log("Topic 'user' created.");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await admin.disconnect();
    await producer.connect();
    console.log("Kafka producer connected");
  } catch (error) {
    if (error.type === 'TOPIC_ALREADY_EXISTS') {
      console.log("Topic 'user' already exists, continuing...");
      await producer.connect();
      return;
    }
    console.error("Error initializing Kafka:", error);
    setTimeout(initKafka, 5000);
  }
}

initKafka().catch(console.error);

async function sendNotification(eventType, payload) {
  try {
    await producer.send({
      topic: "user",
      messages: [{ key: eventType, value: JSON.stringify({ eventType, ...payload }) }],
    });

    // Increment the Prometheus metric for Kafka streams
    kafkaProducerCounter.labels(eventType).inc(); //

    console.log(`Kafka message sent: ${eventType}`);
  } catch (err) {
    console.error("Kafka send error:", err);
  }
}


/* ===========================
   AUTH MIDDLEWARE
=========================== */

//Ai help with this
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
// end of help

/* ===========================
   MONGODB CONNECTION
=========================== */

mongoose.connect(mongoUri)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

/* ===========================
   HATEOAS LINK HELPER
=========================== */
//AI Help
function buildLinks(resource, id) {
  return [
    { rel: "self", href: `/api/v1/${resource}/${id}`, method: "GET" },
    { rel: "update", href: `/api/v1/${resource}/${id}`, method: "PUT" },
    { rel: "delete", href: `/api/v1/${resource}/${id}`, method: "DELETE" }
  ];
}
//end of help

/* ===========================
   AUTH ROUTES
=========================== */

app.post("/api/v1/auth/register", async (req, res) => {
  const { name, email, password, streetAddress } = req.body;

  if (!name || !email || !password || !streetAddress)
    return res.status(400).json({ error: "Missing required fields" });

  const existing = await User.findOne({ email });
  if (existing)
    return res.status(400).json({ error: "Email already exists" });

  const hashed = await bcrypt.hash(password, 10);

  await User.create({
    name,
    email,
    password: hashed,
    streetAddress
  });

  res.status(201).json({ message: "User created" });
});


app.post("/api/v1/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: user.id }, jwtSecret, { expiresIn: "1h" });

  res.json({ token });
});

/* ===========================
   USERS
=========================== */

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  streetAddress: String
});

const User = mongoose.model("User", userSchema);


app.get("/api/v1/users/me", authenticate, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    streetAddress: user.streetAddress,
    links: buildLinks("users", user._id.toString())
  });
});


app.put("/api/v1/users/me", authenticate, async (req, res) => {
  const { name, streetAddress, password } = req.body;
  const updateData = {};

  if (name) updateData.name = name;
  if (streetAddress) updateData.streetAddress = streetAddress;

  if (password) {
    const salt = await bcrypt.genSalt(10);
    updateData.password = await bcrypt.hash(password, salt);
  }

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: updateData },
    { new: true }
  );

  if (!user) return res.status(404).json({ error: "User not found" });

  if (password) {
    await sendNotification("PASSWORD_CHANGED", {
      userId: user._id.toString(),
      email: user.email
    });
  }

  res.json({ message: "User updated" });
});

app.put("/api/v1/users/me/password", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword required" });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.status(401).json({ error: "Current password incorrect" });

  const hashed = await bcrypt.hash(newPassword, 10);
  user.password = hashed;
  await user.save();

  // Send notification
  await sendNotification("PASSWORD_CHANGED", {
    userId: user._id.toString(),
    email: user.email,
    name: user.name,
  });

  res.json({ message: "Password updated" });
});


app.get("/api/v1/users/:id/games", authenticate, async (req, res) => {
  const userExists = await User.findById(req.params.id);
  if (!userExists) return res.status(404).json({ error: "User not found" });

  const userGames = await Game.find({ ownerId: req.params.id });
  res.json(userGames);
});


/* ===========================
   GAMES
=========================== */

const gameSchema = new mongoose.Schema({
  name: String,
  publisher: String,
  yearPublished: Number,
  system: String,
  condition: String,
  previousOwners: Number,
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }
});

const Game = mongoose.model("Game", gameSchema);


app.get("/api/v1/games", authenticate, async (req, res) => {
  const cacheKey = "all_games_list";

  try {
    // 1. Check Redis
    const cachedGames = await redisClient.get(cacheKey);
    if (cachedGames) {
      console.log("REDIS CACHE HIT: Returning data from memory");
      return res.json(JSON.parse(cachedGames));
    }

    // 2. Cache Miss - Hit MongoDB
    console.log("REDIS CACHE MISS: Querying MongoDB");
    const games = await Game.find();

    // 3. Store in Redis for 60 seconds
    await redisClient.setEx(cacheKey, 60, JSON.stringify(games));

    res.json(games);
  } catch (err) {
    console.error("Caching Error:", err);
    // Fallback to normal DB query if Redis fails
    const games = await Game.find();
    res.json(games);
  }
});

//ai help
app.get("/api/v1/games/me", authenticate, async (req, res) => {
  const { name, system } = req.query;
  let result = await Game.find({ ownerId: req.user.id });

  if (name) result = result.filter(g => g.name.includes(name));
  if (system) result = result.filter(g => g.system === system);

  res.json(result);
});
//end

app.post("/api/v1/games", authenticate, async (req, res) => {
  const { name, publisher, yearPublished, system, condition, previousOwners } = req.body;

  if (!name || !publisher || !yearPublished || !system || !condition)
    return res.status(400).json({ error: "Missing required fields" });

  try {
    const game = await Game.create({
      ...req.body,
      ownerId: req.user.id
    });
    await redisClient.del("all_games_list");
    console.log("Redis Cache Invalidated: 'all_games_list' removed.");
    const gameJson = game.toObject();
    gameJson.links = buildLinks("games", game._id.toString());

    res.status(201).json(gameJson);
  } catch (err) {
    console.error("Error creating game:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/api/v1/games/:id", authenticate, async (req, res) => {
  const game = await Game.findById(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  res.json(game);
});


app.put("/api/v1/games/:id", authenticate, async (req, res) => {
  const game = await Game.findById(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (game.ownerId.toString() !== req.user.id) {
    return res.status(403).json({ error: "Not game owner" });
  }

  Object.assign(game, req.body);
  await game.save();

  await redisClient.del("all_games_list");
  console.log("Redis cache cleared: Game updated.");

  res.json({ message: "Game updated" });
});

app.delete("/api/v1/games/:id", authenticate, async (req, res) => {
  const game = await Game.findById(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });

  if (game.ownerId.toString() !== req.user.id) {
    return res.status(403).json({ error: "Not game owner" });
  }

  await Game.findByIdAndDelete(req.params.id);

  await redisClient.del("all_games_list");
  console.log("Redis cache cleared: Game deleted.");

  res.status(204).send();
});

/* ===========================
   Trade Offer
=========================== */

const tradeOfferSchema = new mongoose.Schema({
  offeredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  offeredTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  requestedGame: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Game"
  },
  offeredGame: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Game"
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected"],
    default: "pending"
  }
}, { timestamps: true });

const TradeOffer = mongoose.model("TradeOffer", tradeOfferSchema);

app.post("/api/v1/offers", authenticate, async (req, res) => {
  const { requestedGameId, offeredGameId } = req.body;

  const requestedGame = await Game.findById(requestedGameId);
  const offeredGame = await Game.findById(offeredGameId);

  if (!requestedGame || !offeredGame)
    return res.status(404).json({ error: "Game not found" });

  if (offeredGame.ownerId.toString() !== req.user.id)
    return res.status(403).json({ error: "You don't own the offered game" });

  if (requestedGame.ownerId.toString() === req.user.id)
    return res.status(400).json({ error: "Cannot trade with yourself" });

  const offer = await TradeOffer.create({
    offeredBy: req.user.id,
    offeredTo: requestedGame.ownerId,
    requestedGame: requestedGameId,
    offeredGame: offeredGameId
  });

  await sendNotification("OFFER_CREATED", {
    offerId: offer._id.toString(),
    offeredBy: offer.offeredBy.toString(),
    offeredTo: offer.offeredTo.toString(),
  });


  res.status(201).json(offer);
});

app.get("/api/v1/offers/incoming", authenticate, async (req, res) => {
  const offers = await TradeOffer.find({ offeredTo: req.user.id })
    .populate("offeredBy requestedGame offeredGame");

  res.json(offers);
});

app.put("/api/v1/offers/:id", authenticate, async (req, res) => {
  const offer = await TradeOffer.findById(req.params.id);

  if (!offer)
    return res.status(404).json({ error: "Offer not found" });

  if (offer.offeredTo.toString() !== req.user.id)
    return res.status(403).json({ error: "Not authorized" });

  if (offer.status !== "pending")
    return res.status(400).json({ error: "Offer already processed" });

  //ai help
  const status = req.body?.status;
  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}. Must be accepted or rejected` });
  }
  //end of help

  if (req.body.status === "accepted") {
    await Game.findByIdAndUpdate(offer.requestedGame, {
      ownerId: offer.offeredBy
    });

    await Game.findByIdAndUpdate(offer.offeredGame, {
      ownerId: offer.offeredTo
    });
  }

  offer.status = req.body.status;
  await offer.save();

  await sendNotification(
    status === "accepted" ? "OFFER_ACCEPTED" : "OFFER_REJECTED",
    {
      offerId: offer._id.toString(),
      offeredBy: offer.offeredBy.toString(),
      offeredTo: offer.offeredTo.toString(),
    }
  );


  res.json(offer);
});

/* ===========================
  CONTAINER HEALTH
=========================== */

app.get("/health", (req, res) => {
  res.json({
    message: "API running",
    container: process.env.HOSTNAME
  });
});


/* ===========================
   Admin
=========================== */
//Ai made
app.delete("/admin/wipe", async (req, res) => {
  try {
    await User.deleteMany({});
    await Game.deleteMany({});
    await TradeOffer.deleteMany({});
    res.json({ message: "All data deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete data" });
  }
});
//end
/* ===========================
   START SERVER
=========================== */

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/api/v1`);
});