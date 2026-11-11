// -----------------------------------------------------------------------------
// The texts users read: feature names (in the configured language) and the
// status and action messages (both languages, Gladys picks one). Never a
// token nor a VIN in any of them.
// -----------------------------------------------------------------------------

export const FEATURE_NAMES = {
  fr: {
    battery_level: 'Niveau de batterie',
    usable_battery_level: 'Batterie utilisable',
    rated_range: 'Autonomie nominale',
    estimated_range: 'Autonomie estimée',
    charging_state: 'État de charge',
    plugged_in: 'Câble branché',
    charger_power: 'Puissance de charge',
    charger_current: 'Courant de charge',
    charger_voltage: 'Tension de charge',
    charge_energy_added: 'Énergie ajoutée (dernière charge)',
    charge_limit: 'Limite de charge',
    inside_temperature: 'Température intérieure',
    outside_temperature: 'Température extérieure',
    climate_on: 'Climatisation',
    odometer: 'Compteur kilométrique',
    locked: 'Verrouillage',
    sentry_mode: 'Mode Sentinelle',
    doors_open: 'Portes',
    trunk_open: 'Coffre',
    frunk_open: 'Coffre avant',
    windows_open: 'Fenêtres',
    tyre_front_left: 'Pneu avant gauche',
    tyre_front_right: 'Pneu avant droit',
    tyre_rear_left: 'Pneu arrière gauche',
    tyre_rear_right: 'Pneu arrière droit',
    state: 'État',
    position: 'Position (arrondie)',
  },
  en: {
    battery_level: 'Battery level',
    usable_battery_level: 'Usable battery',
    rated_range: 'Rated range',
    estimated_range: 'Estimated range',
    charging_state: 'Charging state',
    plugged_in: 'Cable plugged in',
    charger_power: 'Charging power',
    charger_current: 'Charging current',
    charger_voltage: 'Charging voltage',
    charge_energy_added: 'Energy added (last charge)',
    charge_limit: 'Charge limit',
    inside_temperature: 'Inside temperature',
    outside_temperature: 'Outside temperature',
    climate_on: 'Climate',
    odometer: 'Odometer',
    locked: 'Lock',
    sentry_mode: 'Sentry mode',
    doors_open: 'Doors',
    trunk_open: 'Trunk',
    frunk_open: 'Front trunk',
    windows_open: 'Windows',
    tyre_front_left: 'Front left tyre',
    tyre_front_right: 'Front right tyre',
    tyre_rear_left: 'Rear left tyre',
    tyre_rear_right: 'Rear right tyre',
    state: 'State',
    position: 'Position (rounded)',
  },
};

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/** Status of the Configuration screen: key -> (params) -> { en, fr }. */
export const STATUS = {
  connected: ({ count, ignored }) => ({
    en: `Connected to Tessie: ${count} vehicle(s)${ignored ? `, ${ignored} more ignored (limit reached)` : ''}.`,
    fr: `Connecté à Tessie : ${count} véhicule(s)${ignored ? `, ${ignored} de plus ignoré(s) (limite atteinte)` : ''}.`,
  }),
  noToken: () => ({
    en: 'Type your Tessie access token (dash.tessie.com, Settings, API).',
    fr: "Saisissez votre jeton d'accès Tessie (dash.tessie.com, Settings, API).",
  }),
  badToken: () => ({
    en: 'The token typed is not valid (a space, a line break or too long): nothing sent.',
    fr: "Le jeton saisi n'est pas valide (espace, retour à la ligne ou trop long) : rien envoyé.",
  }),
  refused: ({ status }) => ({
    en: `Tessie refused the token (${status}). No new try until a new token is saved or the test button succeeds.`,
    fr: `Tessie a refusé le jeton (${status}). Aucun nouvel essai avant l'enregistrement d'un nouveau jeton ou un test réussi.`,
  }),
  paused: ({ left, status }) => ({
    en: `Tessie asked to wait (${status}): next read in about ${minutes(left)} min.`,
    fr: `Tessie a demandé d'attendre (${status}) : prochaine lecture dans ${minutes(left)} min environ.`,
  }),
  unreachable: ({ left, reason }) => ({
    en: `Tessie could not be read (${reason}): next try in about ${minutes(left)} min.`,
    fr: `Tessie n'a pas pu être lu (${reason}) : nouvel essai dans ${minutes(left)} min environ.`,
  }),
  configUnread: () => ({
    en: 'The configuration could not be read from Gladys: trying again.',
    fr: "La configuration n'a pas pu être lue depuis Gladys : nouvel essai en cours.",
  }),
  dataUnreadable: () => ({
    en: 'The /data folder cannot be read: trying again every 10 s before reading Tessie.',
    fr: 'Le dossier /data est illisible : nouvel essai toutes les 10 s avant de lire Tessie.',
  }),
  starting: () => ({
    en: 'Starting: first read of Tessie.',
    fr: 'Démarrage : première lecture de Tessie.',
  }),
};

/** Answers of the "Test the connection" button. */
export const TEST = {
  tooSoon: {
    en: 'A test ran a few seconds ago: try again in 10 s.',
    fr: 'Un test vient d’avoir lieu : réessayez dans 10 s.',
  },
  noToken: STATUS.noToken(),
  badToken: STATUS.badToken(),
  paused: (p) => STATUS.paused(p),
  configUnread: STATUS.configUnread(),
  ok: ({ count }) => ({
    en: `Tessie answered: ${count} vehicle(s) in the account.`,
    fr: `Tessie a répondu : ${count} véhicule(s) dans le compte.`,
  }),
  refused: ({ status }) => ({
    en: `Tessie refused the token (${status}): check it in dash.tessie.com.`,
    fr: `Tessie a refusé le jeton (${status}) : vérifiez-le sur dash.tessie.com.`,
  }),
  failed: ({ reason }) => ({
    en: `Tessie could not be read (${reason}).`,
    fr: `Tessie n'a pas pu être lu (${reason}).`,
  }),
};

/** Why a lock was not sent or not confirmed (English: logs and the Gladys ack). */
export const LOCK = {
  unlock: 'Unlocking is not available in this version of the integration: nothing sent.',
  readOnly: 'This feature is read only: nothing sent.',
  unknownCar: 'This car is not in the Tessie account (or not read yet): nothing sent.',
  noToken: 'No valid Tessie token: lock kept a few minutes, sent as soon as a token is read.',
  noData:
    '/data not read yet (the ids of the cars): lock kept a few minutes, sent once it is read.',
  /** The answer to Gladys when the lock is not confirmed within ~3 s. */
  outcome: (outcome) =>
    ({
      unknownCar: 'This car is not in the Tessie account: nothing sent.',
      pending: 'Lock sent, no confirmation yet: Gladys reads the car again in 5 s and 20 s.',
      notSentRetrying: 'Nothing sent yet (Tessie not reached): tried again within 3 minutes.',
      retrying:
        'Lock sent, not confirmed by the car: tried again (3 tries at most within 3 minutes).',
      notConfirmed: 'Lock sent, not confirmed by the car after the tries.',
      expiredNothingSent: 'Nothing sent: no token or /data could be read within 3 minutes.',
      failed: 'Lock failed: see the logs.',
    })[outcome] ??
    (/^refused \d+$/.test(outcome)
      ? `Tessie refused the lock (${outcome.slice(8)}): not tried again.`
      : 'Nothing sent yet: waiting for a token or /data, a few minutes at most.'),
};
