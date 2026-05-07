#include <sourcemod>
#include <cstrike>

#pragma semicolon 1
#pragma newdecls required

static const int WARMUP_TIMEOUT_SECONDS = 600;

public Plugin myinfo = {
  name = "Compet Match Lock",
  author = "Compet",
  description = "Applies Compet match team locks before get5 is started.",
  version = "0.1.0",
  url = ""
};

StringMap g_PlayerTeams;
bool g_LockEnabled = false;
bool g_Get5Started = false;
char g_MatchId[128] = "";
Handle g_EnforceTimer = null;
Handle g_WarmupTimeoutTimer = null;

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  RestartWarmupTimeout();
}

public void OnPluginEnd() {
  StopWarmupTimeout();
}

public void OnClientPostAdminCheck(int client) {
  if (!g_LockEnabled || IsFakeClient(client)) {
    return;
  }

  CreateTimer(0.2, Timer_ApplyClientLock, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Command_ResetLock(int args) {
  g_PlayerTeams.Clear();
  g_LockEnabled = false;
  g_Get5Started = false;
  StopEnforceTimer();
  g_MatchId[0] = '\0';
  if (args >= 1) {
    GetCmdArg(1, g_MatchId, sizeof(g_MatchId));
  }
  RestartWarmupTimeout();
  return Plugin_Handled;
}

public Action Command_AddPlayer(int args) {
  if (args < 2) {
    PrintToServer("[Compet] Usage: compet_lock_add <steam64> <t|ct>");
    return Plugin_Handled;
  }
  char auth[32];
  char side[8];
  GetCmdArg(1, auth, sizeof(auth));
  GetCmdArg(2, side, sizeof(side));

  int team = SideToTeam(side);
  if (team == CS_TEAM_NONE) {
    PrintToServer("[Compet] Invalid side for %s: %s", auth, side);
    return Plugin_Handled;
  }

  g_PlayerTeams.SetValue(auth, team);
  return Plugin_Handled;
}

public Action Command_EnableLock(int args) {
  char enabled[8] = "1";
  if (args >= 1) {
    GetCmdArg(1, enabled, sizeof(enabled));
  }
  g_LockEnabled = !StrEqual(enabled, "0");
  if (g_LockEnabled) {
    StartEnforceTimer();
  } else {
    StopEnforceTimer();
  }
  for (int client = 1; client <= MaxClients; client++) {
    if (IsClientInGame(client) && !IsFakeClient(client)) {
      ApplyClientLock(client, false, CS_TEAM_NONE);
    }
  }
  PrintToServer("[Compet] Match lock %s for %s", g_LockEnabled ? "enabled" : "disabled", g_MatchId);
  return Plugin_Handled;
}

public void Get5_OnGameStateChanged(Handle event) {
  MarkGet5Started();
}

public Action Command_JoinTeam(int client, const char[] command, int argc) {
  if (!g_LockEnabled || client <= 0 || !IsClientInGame(client) || IsFakeClient(client)) {
    return Plugin_Continue;
  }

  int requestedTeam = RequestedTeamFromArgs(argc);
  return ApplyClientLock(client, true, requestedTeam) ? Plugin_Continue : Plugin_Stop;
}

public Action Timer_EnforceLocks(Handle timer, any data) {
  if (!g_LockEnabled) {
    g_EnforceTimer = null;
    return Plugin_Stop;
  }

  for (int client = 1; client <= MaxClients; client++) {
    if (IsClientInGame(client) && !IsFakeClient(client)) {
      ApplyClientLock(client, false, CS_TEAM_NONE);
    }
  }
  return Plugin_Continue;
}

public Action Timer_ApplyClientLock(Handle timer, int userId) {
  int client = GetClientOfUserId(userId);
  if (client > 0 && IsClientInGame(client) && !IsFakeClient(client)) {
    ApplyClientLock(client, false, CS_TEAM_NONE);
  }
  return Plugin_Stop;
}

bool ApplyClientLock(int client, bool fromCommand, int requestedTeam) {
  char auth[32];
  if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)) {
    return true;
  }

  int lockedTeam = CS_TEAM_NONE;
  if (!g_PlayerTeams.GetValue(auth, lockedTeam)) {
    KickClient(client, "You are not assigned to this Compet match.");
    return false;
  }

  if (IsPlayingTeam(requestedTeam) && requestedTeam != lockedTeam) {
    ChangeClientTeam(client, lockedTeam);
    if (fromCommand) {
      PrintToChat(client, "[Compet] You have been assigned to your match team.");
    }
    return false;
  }

  int currentTeam = GetClientTeam(client);
  if (currentTeam != lockedTeam) {
    ChangeClientTeam(client, lockedTeam);
    if (fromCommand) {
      PrintToChat(client, "[Compet] You have been assigned to your match team.");
    }
    return false;
  }

  return !fromCommand;
}

void StartEnforceTimer() {
  if (g_EnforceTimer != null) {
    return;
  }
  g_EnforceTimer = CreateTimer(1.0, Timer_EnforceLocks, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void StopEnforceTimer() {
  if (g_EnforceTimer == null) {
    return;
  }
  delete g_EnforceTimer;
  g_EnforceTimer = null;
}

void RestartWarmupTimeout() {
  if (g_Get5Started) {
    return;
  }
  StopWarmupTimeout();
  StartWarmupCountdown();
  g_WarmupTimeoutTimer = CreateTimer(float(WARMUP_TIMEOUT_SECONDS), Timer_WarmupTimeout, 0, TIMER_FLAG_NO_MAPCHANGE);
}

void StartWarmupCountdown() {
  ServerCommand("mp_do_warmup_period 1");
  ServerCommand("mp_warmuptime %d", WARMUP_TIMEOUT_SECONDS);
  ServerCommand("mp_warmup_start");
  ServerExecute();
}

void StopWarmupTimeout() {
  if (g_WarmupTimeoutTimer == null) {
    return;
  }
  delete g_WarmupTimeoutTimer;
  g_WarmupTimeoutTimer = null;
}

void MarkGet5Started() {
  if (g_Get5Started) {
    return;
  }
  g_Get5Started = true;
  StopWarmupTimeout();
}

public Action Timer_WarmupTimeout(Handle timer, any data) {
  g_WarmupTimeoutTimer = null;
  if (g_Get5Started) {
    return Plugin_Stop;
  }

  PrintToServer("[Compet] Warmup timeout expired before get5 started; shutting down server.");
  ServerCommand("quit");
  ServerExecute();
  return Plugin_Stop;
}

bool IsPlayingTeam(int team) {
  return team == CS_TEAM_T || team == CS_TEAM_CT;
}

int RequestedTeamFromArgs(int argc) {
  if (argc < 1) {
    return CS_TEAM_NONE;
  }

  char arg[16];
  GetCmdArg(1, arg, sizeof(arg));
  return SideToTeam(arg);
}

int SideToTeam(const char[] side) {
  if (StrEqual(side, "t", false) || StrEqual(side, "2")) {
    return CS_TEAM_T;
  }
  if (StrEqual(side, "ct", false) || StrEqual(side, "3")) {
    return CS_TEAM_CT;
  }
  return CS_TEAM_NONE;
}
