import { createApp } from "./app.ts";

// The coordinator owns the trial lifetime; this process only serves until released.
const suppliedCoordinator = process.env.MAKEFUN_ENV_URL;

if (!suppliedCoordinator) {
  process.stderr.write("MAKEFUN_ENV_URL is required to start the trial\n");
  process.exit(1);
}

const coordinator = suppliedCoordinator.replace(/\/+$/, "");
const service = createApp();
const coordinatorTimeout = 30_000;
const firstRetry = 250;
const retryCeiling = 2_000;

const pause = (milliseconds: number) =>
  new Promise<void>((resume) => setTimeout(resume, milliseconds));

const retryInterval = (failures: number) =>
  Math.min(retryCeiling, firstRetry * 2 ** Math.min(failures, 8));

class RegistrationContractError extends Error {}

async function openEphemeralListener(): Promise<number> {
  await new Promise<void>((ready, failed) => {
    const rejectListen = (problem: Error) => failed(problem);

    service.once("error", rejectListen);
    service.listen(0, () => {
      service.off("error", rejectListen);
      ready();
    });
  });

  const socket = service.address();
  if (socket === null || typeof socket === "string") {
    throw new Error("The trial server did not receive a TCP port");
  }

  return socket.port;
}

async function offerPort(port: number): Promise<void> {
  let failures = 0;

  for (;;) {
    try {
      const acknowledgement = await fetch(`${coordinator}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(coordinatorTimeout),
      });

      if (acknowledgement.status === 200 || acknowledgement.status === 409) {
        return;
      }

      if (acknowledgement.status === 400 || acknowledgement.status === 405) {
        const explanation = await acknowledgement.text();
        throw new RegistrationContractError(
          `Coordinator rejected registration (${acknowledgement.status}): ${explanation}`,
        );
      }
    } catch (problem) {
      if (problem instanceof RegistrationContractError) {
        throw problem;
      }
    }

    await pause(retryInterval(failures));
    failures += 1;
  }
}

async function readCompletionFlag(): Promise<boolean> {
  const reply = await fetch(`${coordinator}/done`, {
    signal: AbortSignal.timeout(coordinatorTimeout),
  });

  if (!reply.ok) {
    throw new Error(`Coordinator poll returned ${reply.status}`);
  }

  const message: unknown = await reply.json();
  return (
    typeof message === "object" &&
    message !== null &&
    "done" in message &&
    message.done === true
  );
}

async function awaitCoordinatorRelease(): Promise<void> {
  let failedPolls = 0;

  for (;;) {
    try {
      if (await readCompletionFlag()) {
        return;
      }

      failedPolls = 0;
    } catch {
      failedPolls += 1;
    }

    await pause(retryInterval(failedPolls));
  }
}

async function closeListener(): Promise<void> {
  await new Promise<void>((closed, failed) => {
    service.close((problem) => {
      if (problem) {
        failed(problem);
        return;
      }

      closed();
    });
  });
}

const assignedPort = await openEphemeralListener();
await offerPort(assignedPort);
await awaitCoordinatorRelease();
await closeListener();

process.exitCode = 0;
