require("dotenv").config();
const { Kafka } = require("kafkajs");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const express = require("express"); //
const client = require('prom-client'); //

const app = express(); //
const register = new client.Registry(); //

//
client.collectDefaultMetrics({ register });

// Custom metric to track emails sent by the mailer
const emailSentCounter = new client.Counter({
  name: 'mailer_emails_sent_total',
  help: 'Total number of emails sent by the mailer service',
  labelNames: ['event_type', 'status']
});
register.registerMetric(emailSentCounter);

//
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Start the metrics server on port 3000
const METRICS_PORT = 3000;
app.listen(METRICS_PORT, () => {
  console.log(`Mailer metrics server running on port ${METRICS_PORT}`);
});

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  streetAddress: String,
});
const User = mongoose.model("User", userSchema);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Mailer connected to MongoDB"))
  .catch(err => {
    console.error("Mailer Mongo error:", err);
    process.exit(1);
  });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, text, eventType) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "no-reply@gametrader.com",
      to,
      subject,
      text,
    });
    //
    emailSentCounter.labels(eventType, 'success').inc();
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    //
    emailSentCounter.labels(eventType, 'failure').inc();
    console.error(`Email failed to ${to}:`, err);
  }
}

const kafka = new Kafka({
  clientId: "mailer-service",
  brokers: ["kafka:29092"],
});

const consumer = kafka.consumer({ groupId: "mailer-group" });

async function run() {
  await consumer.connect();
  await consumer.subscribe({ topic: "user", fromBeginning: false });

  console.log("Mailer waiting for email notifications...");

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      const data = JSON.parse(message.value.toString());
      const { eventType } = data;

      try {
        switch (eventType) {
          case "PASSWORD_CHANGED":
            const user = await User.findById(data.userId);
            if (user) {
              await sendEmail(
                user.email,
                "Security Alert: Password Changed",
                `Hi ${user.name},\n\nYour password was recently changed.\n\nIf this wasn't you, please contact support.\n\nGameTrader`,
                eventType
              );
            }
            break;

          case "OFFER_CREATED":
            const [offeror, offeree] = await Promise.all([
              User.findById(data.offeredBy),
              User.findById(data.offeredTo),
            ]);
            if (offeror && offeror.email) {
              await sendEmail(
                offeror.email,
                "You created a game trade offer",
                `Hi ${offeror.name},\n\nYour game trade offer has been created.\n\nGameTrader`,
                eventType
              );
            }
            if (offeree && offeree.email) {
              await sendEmail(
                offeree.email,
                "You received a new game trade offer",
                `Hi ${offeree.name},\n\nSomeone wants to trade games with you!\n\nGameTrader`,
                eventType
              );
            }
            break;

          case "OFFER_ACCEPTED":
          case "OFFER_REJECTED":
            const [sender, receiver] = await Promise.all([
              User.findById(data.offeredBy),
              User.findById(data.offeredTo),
            ]);
            const action = eventType === "OFFER_ACCEPTED" ? "accepted" : "rejected";
            if (sender && sender.email) {
              await sendEmail(
                sender.email,
                `Your game offer was ${action}`,
                `Hi ${sender.name},\n\nYour game offer was ${action}.\n\nGameTrader`,
                eventType
              );
            }
            if (receiver && receiver.email) {
              await sendEmail(
                receiver.email,
                `You ${action} a game offer`,
                `Hi ${receiver.name},\n\nYou ${action} a game trade offer.\n\nGameTrader`,
                eventType
              );
            }
            break;
        }
      } catch (err) {
        console.error(`Error processing ${eventType}:`, err);
      }
    },
  });
}

run().catch(console.error);