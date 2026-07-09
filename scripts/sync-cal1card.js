import { createApplication } from "../src/app.js";

const application = createApplication();

try {
  const result = await application.services.syncService.sync();
  console.log(
    `[${new Date().toISOString()}] sync ok: new=${result.insertedCount}, total=${result.totalCount}`,
  );
} catch (error) {
  const code = error?.code ?? "SYNC_FAILED";
  console.error(`[${new Date().toISOString()}] sync failed: ${code}`);
  process.exitCode = code === "NEEDS_BINDING" ? 2 : 1;
} finally {
  await application.close();
}
