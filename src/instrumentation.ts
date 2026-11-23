export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRecordingSyncLoop } = await import("@/lib/server/recordings-sync");
    startRecordingSyncLoop();
  }
}
