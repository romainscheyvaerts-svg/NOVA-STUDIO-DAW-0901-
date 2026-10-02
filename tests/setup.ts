/**
 * Préparation commune des tests : les modules du studio écrivent beaucoup
 * dans la console (registre des buffers, Supabase…). On la fait taire, sauf
 * avec TEST_VERBOSE=1 pour déboguer un test.
 */
if (!process.env.TEST_VERBOSE) {
  const noop = () => { /* silencieux */ };
  console.log = noop;
  console.info = noop;
  console.warn = noop;
}
