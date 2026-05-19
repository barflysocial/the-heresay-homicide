# Heresay Homicide Build Notes

Template used: Pelican to Murder final build.

## What changed
- Rebranded game to **Heresay Homicide**.
- Venue changed to **Heresay Speakeasy at Circa 1857 Antique Store, Baton Rouge**.
- Maintained the same folder hierarchy, server setup, host flow, player flow, RSVP flow, access-code flow, and Render commands.
- Updated one-time paid access codes from `PTM-` to `HH-`.
- Added a new title background graphic: `public/assets/heresay-title-bg.png`.
- Added five new Heresay Homicide truth packs:
  - Level 1: Training Detective
  - Level 2: Rookie Detective
  - Level 3: Junior Detective
  - Level 4: Detective
  - Level 5: Senior Detective

## Core case theme
The mystery is built around rumors, overheard statements, deleted posts, witness contradictions, and physical/digital proof. The attached Circa 1857 antique store matters because it creates shared access paths, storage areas, keys, antique displays, and hidden movement opportunities.

## Commands
```bash
npm install
npm start
```

Render:
```text
Build Command: npm install
Start Command: npm start
NODE_VERSION: 20.18.1
```


## Continuous Story Mode Update
This build changes Heresay Homicide from separate level cases into one continuous five-chapter story. Each chapter still increases difficulty, but every chapter reveals a deeper layer of the same homicide connected to Heresay Speakeasy and the attached Circa 1857 antique store.

Chapters:
1. Last Call at Heresay — The Body in the Speakeasy
2. The Locked Cabinet — The Antique Store Connection
3. A Rumor in the Walls — The Lie Everyone Repeated
4. The Object That Should Not Exist — The Circa Ledger
5. The Truth Beneath Third Street — The Real Homicide
