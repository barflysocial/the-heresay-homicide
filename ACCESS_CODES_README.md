# Paid Player Access Codes

This build uses personal one-time access codes instead of a shared player join code.

## Host flow
1. Open `/host/`.
2. Choose the Heresay Homicide level.
3. Set Paid Player Spots, default 25.
4. Click Create Session.
5. Give one unique access code to each paid player.
6. Players join at `/player/` using their personal code.

## Player flow
1. Open `/player/`.
2. Enter detective name.
3. Enter personal access code, such as `HH-8K2Q`.
4. If valid and unused, the player enters the lobby.

## Rules
- Each access code can be claimed once.
- A claimed code cannot be used by another player.
- Reset Session clears players and answers, and makes access codes unclaimed again.
- Delete Session permanently removes the session and all access codes from the database.
- The Paid toggle is manual tracking for the host.
