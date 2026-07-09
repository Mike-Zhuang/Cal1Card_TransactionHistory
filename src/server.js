import { createApplication } from "./app.js";

const application = createApplication();

if (!process.env.CAL1CARD_APP_PASSWORD) {
  console.warn("WARNING: CAL1CARD_APP_PASSWORD 未设置，当前使用开发密码 cal1card-dev。");
}

application.server.listen(application.config.port, application.config.host, () => {
  console.log(
    `Cal1Card server listening on http://${application.config.host}:${application.config.port}`,
  );
  console.log(`Web login enabled: ${application.config.webLoginEnabled}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  application.server.close(async () => {
    await application.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
