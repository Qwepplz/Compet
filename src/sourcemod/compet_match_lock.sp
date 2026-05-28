#include <sourcemod>
#include <cstrike>

#pragma semicolon 1
#pragma newdecls required

#define COMPET_STATUS_BUFFER_SIZE 8192
#define COMPET_STATUS_INTERVAL 30.0

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
Handle g_StatusTimer = null;

public void OnPluginStart() {
  g_PlayerTeams = new StringMap();
  RegServerCmd("compet_lock_reset", Command_ResetLock);
  RegServerCmd("compet_lock_add", Command_AddPlayer);
  RegServerCmd("compet_lock_enable", Command_EnableLock);
  AddCommandListener(Command_JoinTeam, "jointeam");
  AddCommandListener(Command_JoinTeam, "joingame");
  PrintToServer("[Compet] Match lock plugin loaded; waiting for compet_lock_reset.");
}

public void OnPluginEnd() {
  StopEnforceTimer();
  StopStatusTimer();
}

public void OnMapEnd() {
  g_EnforceTimer = null;
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
  StopStatusTimer();
  g_MatchId[0] = '\0';
  if (args >= 1) {
    GetCmdArg(1, g_MatchId, sizeof(g_MatchId));
  }
  ClearShutdownFlag();
  StartStatusTimer();
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

public void Get5_OnKnifeRoundStarted(Handle event) {
  MarkGet5Started("get5 knife round started");
}

public void Get5_OnGoingLive(Handle event) {
  MarkGet5Started("get5 going live");
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

public Action Timer_WriteStatus(Handle timer, any data) {
  if (g_MatchId[0] == '\0') {
    g_StatusTimer = null;
    return Plugin_Stop;
  }

  WriteStatusFiles();
  CheckShutdownFlag();
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

void MarkGet5Started(const char[] reason) {
  if (g_Get5Started || !g_LockEnabled || g_MatchId[0] == '\0') {
    return;
  }
  g_Get5Started = true;
  g_LockEnabled = false;
  StopEnforceTimer();
  PrintToServer("[Compet] %s; pre-get5 team lock disabled for match %s.", reason, g_MatchId);
  PrintToChatAll("[Compet] get5 has started; pre-match team lock disabled.");
}

void StartEnforceTimer() {
  if (g_EnforceTimer != null) {
    return;
  }
  g_EnforceTimer = CreateTimer(1.0, Timer_EnforceLocks, 0, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);
}

void StartStatusTimer() {
  if (g_StatusTimer != null || g_MatchId[0] == '\0') {
    return;
  }
  WriteStatusFiles();
  g_StatusTimer = CreateTimer(COMPET_STATUS_INTERVAL, Timer_WriteStatus, 0, TIMER_REPEAT);
}

void StopEnforceTimer() {
  if (g_EnforceTimer == null) {
    return;
  }
  delete g_EnforceTimer;
  g_EnforceTimer = null;
}

void StopStatusTimer() {
  if (g_StatusTimer == null) {
    return;
  }
  delete g_StatusTimer;
  g_StatusTimer = null;
}

void WriteStatusFiles() {
  if (g_MatchId[0] == '\0' || !EnsureCompetDataDir()) {
    return;
  }

  int connectedCount = 0;
  int humanCount = 0;
  int botCount = 0;
  char humans[1024];
  humans[0] = '\0';

  for (int client = 1; client <= MaxClients; client++) {
    if (!IsClientConnected(client)) {
      continue;
    }
    connectedCount++;
    if (IsFakeClient(client) || IsClientSourceTV(client) || IsClientReplay(client)) {
      botCount++;
      continue;
    }
    if (!IsClientInGame(client)) {
      continue;
    }

    char auth[32];
    if (!GetClientAuthId(client, AuthId_SteamID64, auth, sizeof(auth), true)) {
      continue;
    }
    AppendHumanAuth(humans, sizeof(humans), auth, humanCount);
    humanCount++;
  }

  WriteJsonStatus(connectedCount, humanCount, botCount, humans);
  WriteConsoleStatus();
}

void AppendHumanAuth(char[] humans, int maxlen, const char[] auth, int index) {
  char piece[48];
  if (index > 0) {
    Format(piece, sizeof(piece), ",\"%s\"", auth);
  } else {
    Format(piece, sizeof(piece), "\"%s\"", auth);
  }
  StrCat(humans, maxlen, piece);
}

void WriteJsonStatus(int connectedCount, int humanCount, int botCount, const char[] humans) {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/server_status.json");

  File file = OpenFile(path, "w");
  if (file == null) {
    PrintToServer("[Compet] Failed to open status file: %s", path);
    return;
  }

  WriteFileLine(file, "{");
  WriteFileLine(file, "  \"matchId\": \"%s\",", g_MatchId);
  WriteFileLine(file, "  \"generatedAtUnix\": %d,", GetTime());
  WriteFileLine(file, "  \"connectedCount\": %d,", connectedCount);
  WriteFileLine(file, "  \"humanCount\": %d,", humanCount);
  WriteFileLine(file, "  \"botCount\": %d,", botCount);
  WriteFileLine(file, "  \"humans\": [%s],", humans);
  WriteFileLine(file, "  \"lockEnabled\": %s,", g_LockEnabled ? "true" : "false");
  WriteFileLine(file, "  \"get5Started\": %s", g_Get5Started ? "true" : "false");
  WriteFileLine(file, "}");
  FlushFile(file);
  delete file;
}

void WriteConsoleStatus() {
  char output[COMPET_STATUS_BUFFER_SIZE];
  output[0] = '\0';
  ServerCommandEx(output, sizeof(output), "status");

  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/server_status.txt");

  File file = OpenFile(path, "w");
  if (file == null) {
    PrintToServer("[Compet] Failed to open console status file: %s", path);
    return;
  }

  WriteFileString(file, output, false);
  FlushFile(file);
  delete file;
}

void CheckShutdownFlag() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/shutdown.flag");
  if (!FileExists(path)) {
    return;
  }

  char requestedMatchId[128];
  requestedMatchId[0] = '\0';
  File file = OpenFile(path, "r");
  if (file != null) {
    ReadFileLine(file, requestedMatchId, sizeof(requestedMatchId));
    delete file;
  }
  DeleteFile(path);
  TrimString(requestedMatchId);

  if (g_MatchId[0] == '\0' || !StrEqual(requestedMatchId, g_MatchId)) {
    PrintToServer("[Compet] Ignored shutdown flag for %s while running %s.", requestedMatchId, g_MatchId);
    return;
  }

  PrintToServer("[Compet] Empty server shutdown requested for match %s.", g_MatchId);
  ServerCommand("quit");
}

void ClearShutdownFlag() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet/shutdown.flag");
  if (FileExists(path)) {
    DeleteFile(path);
  }
}

bool EnsureCompetDataDir() {
  char path[PLATFORM_MAX_PATH];
  BuildPath(Path_SM, path, sizeof(path), "data/compet");
  return DirExists(path) || CreateDirectory(path);
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
