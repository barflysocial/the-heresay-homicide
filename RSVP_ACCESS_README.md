# RSVP + Paid Access Code Flow

This build supports both RSVP collection and paid one-time access codes.

## Public player page
Players can open `/player/` and choose:

- **RSVP**: saves their interest to the database. This does not let them enter the live game.
- **Have Access Code**: lets a paid player enter the live game using their unique one-time access code.

The host dashboard does **not** need to stay open for RSVP to work. The Render server and database only need to be running.

## RSVP fields
- First name required
- Last name required
- Phone or email required
- Instagram optional
- Optional team name

## Host dashboard
The host can:

- View RSVP list
- Mark RSVPs paid/unpaid
- Assign an unused access code to a paid RSVP
- Copy the assigned access code
- View checked-in status after the player joins with their code

## Game entry rule
RSVP alone does not enter the game. A player must have a valid personal access code to check in and join the lobby.
