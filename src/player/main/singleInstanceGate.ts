export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
};

export type SingleInstanceGateResult = {
  enforceSingleInstance: boolean;
  gotLock: boolean;
};

export function isPlayerMultiInstanceAllowed(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.COMPET_ALLOW_MULTI_INSTANCE === "1";
}

export function acquirePlayerSingleInstanceGate(
  app: SingleInstanceApp,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SingleInstanceGateResult {
  if (isPlayerMultiInstanceAllowed(env)) {
    return { enforceSingleInstance: false, gotLock: true };
  }

  const gotLock = app.requestSingleInstanceLock();
  return {
    enforceSingleInstance: true,
    gotLock,
  };
}
