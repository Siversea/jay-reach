import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { shouldBlindRetry, verdictFromBalance } from './credit-state.ts';

// ─── verdictFromBalance ─────────────────────────────────────────────────────
// true = a sec (pause), false = OK (reprise possible), null = on ne touche a
// rien. Seuil de pause = 5, marge de reprise = 10 → on ne reprend qu'a 15+.

Deno.test('verdictFromBalance : solde sous le seuil = pause', () => {
  assertEquals(verdictFromBalance(0, 5, false, 10), true);
  assertEquals(verdictFromBalance(4.9, 5, false, 10), true);
});

Deno.test('verdictFromBalance : solde confortable = OK', () => {
  assertEquals(verdictFromBalance(500, 5, false, 10), false);
  assertEquals(verdictFromBalance(5, 5, false, 10), false);
});

Deno.test('verdictFromBalance : hysteresis, pas de reprise dans la bande', () => {
  // Deja en pause avec 8 credits : au-dessus du seuil de pause (5) mais sous
  // le seuil de reprise (5 + 10). On reste en pause plutot que de repartir
  // pour se reprendre un 402 trois minutes plus tard.
  assertEquals(verdictFromBalance(8, 5, true, 10), null);
  assertEquals(verdictFromBalance(14.9, 5, true, 10), null);
});

Deno.test('verdictFromBalance : reprise franche au-dessus de la marge', () => {
  assertEquals(verdictFromBalance(15, 5, true, 10), false);
  assertEquals(verdictFromBalance(1000, 5, true, 10), false);
});

Deno.test('verdictFromBalance : solde illisible = indetermine', () => {
  // null ne doit jamais etre interprete comme "plus de credits" : ca mettrait
  // le pipeline en pause sur une simple erreur reseau du provider.
  assertEquals(verdictFromBalance(null, 5, false, 10), null);
  assertEquals(verdictFromBalance(null, 5, true, 10), null);
});

Deno.test('verdictFromBalance : un solde a sec repasse en pause meme deja en pause', () => {
  assertEquals(verdictFromBalance(1, 5, true, 10), true);
});

// ─── shouldBlindRetry ───────────────────────────────────────────────────────

const NOW = new Date('2026-07-27T12:00:00Z').getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

Deno.test('shouldBlindRetry : pas de retry avant le delai', () => {
  assertEquals(shouldBlindRetry(minutesAgo(10), 60, NOW), false);
  assertEquals(shouldBlindRetry(minutesAgo(59), 60, NOW), false);
});

Deno.test('shouldBlindRetry : retry une fois le delai ecoule', () => {
  assertEquals(shouldBlindRetry(minutesAgo(60), 60, NOW), true);
  assertEquals(shouldBlindRetry(minutesAgo(600), 60, NOW), true);
});

Deno.test('shouldBlindRetry : date absente ou invalide = pas de retry', () => {
  assertEquals(shouldBlindRetry(null, 60, NOW), false);
  assertEquals(shouldBlindRetry('pas-une-date', 60, NOW), false);
});
