// One PocketIC server for the run; each test file creates its own instance.
import { PocketIcServer } from "@dfinity/pic";

let server;

export async function setup({ provide }) {
  server = await PocketIcServer.start();
  provide("PIC_URL", server.getUrl());
}

export async function teardown() {
  await server?.stop();
}
