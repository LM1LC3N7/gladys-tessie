# Tessie for Gladys

Shows the Teslas of your **Tessie** account in Gladys: battery level, range,
charging state and power, climate, inside and outside temperatures, doors,
trunks, windows, lock, Sentry mode, tyre pressures, odometer and state. One
command: **Lock**.

Never tested with a real car. Unofficial, not affiliated with Tesla nor with
Tessie.

## What you need

- A Tessie account (a paid service, [tessie.com](https://tessie.com)) with
  your car(s) in it.
- An access token: in [dash.tessie.com](https://dash.tessie.com/settings/api),
  Settings, API, **Generate Access Token**.

## Setting up

1. Install the integration from the Gladys store.
2. In its configuration, paste the token in **Tessie access token**. It is
   kept by Gladys in its database, never shown again, and sent only to Tessie
   (`api.tessie.com`), in a header.
3. Save, then **Test the connection**: it answers with the number of cars
   Tessie returns.
4. In **Discovery**, create each car.

## What is read, and how often

Every **read interval** (5 minutes by default, 60 s to 1 hour), Gladys reads
the latest state Tessie knows of each car. Gladys **never asks Tessie to
wake a car** to read it: a sleeping car keeps the values of its last wake.

Each group of values (charge, climate, vehicle, position) carries the time
Tessie got it from the car:

- less than 10 minutes old: shown as a new value (scenes may react);
- older: shown with its own date (scenes do not react);
- older than 2 hours: not shown;
- a value already shown is not sent again.

Distances are in km (Tesla gives miles: converted), temperatures in °C,
tyre pressures in bar. A value the car does not give stays unknown, never 0.
The odometer never goes down.

At most 10 cars are followed (the status says how many are left out).

## Lock

The **Lock** feature of a car is the only command. Setting it to locked sends
Tessie's lock command (Tessie wakes the car if needed). It is sent even when
Tessie asked to wait, when Tessie refused the token for the reads, or during a
read. It is tried up to 3 times within 3 minutes, and sent again after a
restart of the integration within that time. It ends when the car confirms,
or when a read dated after the command shows the car locked while it was
known unlocked before (an older read never counts). Gladys reads the car again
5 s and 20 s after it. When the car has not confirmed within about 3 seconds,
Gladys shows an error saying what was sent and what goes on.

It is not sent when:

- no valid token is configured yet (it waits up to 3 minutes for one);
- the car is no longer in the Tessie account (when the key of the car ids was
  lost, the only car of the account is locked if Gladys has a single Tessie
  car);
- Tessie refuses the command (401, 403 or another 4xx than 429): it is not tried
  again;
- the 3 tries are used up, or the 3 minutes are over.

**Unlocking is not available** (nor trunks, charge port, climate): setting the
feature to unlocked is refused and nothing is sent.

## The position (off by default)

Turn on **Show the position of the car, rounded** to get a text feature with
the latitude and longitude rounded to 3 decimals (about 100 m), shown only
when Tessie's value is less than 10 minutes old. Turning it off erases the
value shown. The navigation (destination), speed and heading are never read.

## The status

- **Connected to Tessie: N vehicle(s)**: all fine.
- **Tessie refused the token (401/403)**: the reads stop until you save a new
  token or the test button succeeds.
- **Tessie asked to wait (429 or 5xx)**: the reads wait as long as Tessie
  says (1 minute to 6 hours, kept across restarts).
- **Tessie could not be read**: network or timeout; tried again later, the
  wait doubling up to 1 hour.
- **The configuration could not be read from Gladys**: tried again, spaced,
  without end.
- **The /data folder cannot be read**: the reads wait (a stop may be saved in
  it), tried again every 10 s, without end. The lock still goes.
- **The /data folder cannot be written** (at the end of "Connected"): the
  reads go on; pauses and pending locks are not kept across a restart.

## Privacy

The token and the VIN are never written to the logs, the status, nor the
integration's `/data` folder; the logs name a car by its rank (#1, #2...). A
car is known to Gladys by a code made from its VIN with a random key: without
that key, the VIN cannot be found back from the code. The key is kept twice,
in the integration's settings in Gladys (never shown in the form) and in
`/data`, so losing one of them changes nothing. If both are lost (Gladys
database restored without them and integration reinstalled), the cars come
back in Discovery as new devices: the old devices, their history and the
scenes using them must be moved to the new ones.
