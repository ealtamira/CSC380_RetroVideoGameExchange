require("dotenv").config();
const { Kafka } = require("kafkajs");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");

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

// Email transport (Mailtrap, Gmail, etc.)
const transporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "no-reply@gametrader.com",
      to,
      subject,
      text,
    });
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`Email failed to ${to}:`, err);
  }
}

const kafka = new Kafka({
  clientId: "mailer-service",
  brokers: ["kafka:9092"],
});

const consumer = kafka.consumer({ groupId: "mailer-group" });

async function run() {
  await consumer.connect();
  await consumer.subscribe({ topic: "email-notifications", fromBeginning: false });

  console.log("Mailer waiting for email notifications...");

  await consumer.run({
    eachMessage: async ({ message }) => {
      const data = JSON.parse(message.value.toString());
      const { eventType } = data;

      try {
        switch (eventType) {
          case "PASSWORD_CHANGED":
            const user = await User.findById(data.userId);
            if (user) {
              await sendEmail(
                user.email,
                "Your password was changed",
                `Hi ${user.name},\n\nYour password was recently changed.\n\nIf this wasn't you, please contact support.\n\nGameTrader`
              );
            }
            break;

          case "OFFER_CREATED":
            const [offeror, offeree] = await Promise.all([
              User.findById(data.offeredBy),
              User.findById(data.offeredTo),
            ]);
            if (offeror) {
              await sendEmail(
                offeror.email,
                "You created a game trade offer",
                `Hi ${offeror.name},\n\nYour game trade offer has been created.\n\nGameTrader`
              );
            }
            if (offeree) {
              await sendEmail(
                offeree.email,
                "You received a new game trade offer",
                `Hi ${offeree.name},\n\nSomeone wants to trade games with you!\n\nGameTrader`
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
            if (sender) {
              await sendEmail(
                sender.email,
                `Your game offer was ${action}`,
                `Hi ${sender.name},\n\nYour game offer was ${action}.\n\nGameTrader`
              );
            }
            if (receiver) {
              await sendEmail(
                receiver.email,
                `You ${action} a game offer`,
                `Hi ${receiver.name},\n\nYou ${action} a game trade offer.\n\nGameTrader`
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
