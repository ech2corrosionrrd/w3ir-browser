'use strict';
// Публічні ключі для перевірки підписів оновлень Ed25519 (приватні ключі зберігаються окремо в build/keys/).
// Первинний публічний ключ:
const PRIMARY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3Lj9EKu1tyaFf9jkkOWpR8cc9kBidkH9mcvcGItDnmk=\n-----END PUBLIC KEY-----\n';
// Резервний публічний ключ (на випадок планової ротації або втрати первинного ключа):
const BACKUP = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEADSIRyOSenCs6B9WMMW8lEFI1L4zaDaJqyT8FBUgUoO8=\n-----END PUBLIC KEY-----\n';

const TRUSTED_KEYS = [PRIMARY, BACKUP];
TRUSTED_KEYS.PRIMARY = PRIMARY;
TRUSTED_KEYS.BACKUP = BACKUP;

module.exports = TRUSTED_KEYS;
