// Loaded once via `node --test --import ./tests/setup.ts`. Pulls in the
// @js-joda timezone database so `ZoneId.of('America/New_York')` resolves
// without each test file having to remember the side-effect import.
import '@js-joda/timezone';
