import { AuditEngine, newAuditRecord, summarise } from './audit/engine.ts';
import { createProvider, createStores } from './config.ts';

const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const provider = createProvider(log);
  const { evidence, store } = createStores();
  try {
    if (cmd === 'connect') {
      console.error('Opening ChatGPT so you can sign in normally. This window will close once you are signed in.');
      const ok = await provider.connectForSignIn();
      console.log(ok ? 'CONNECTED' : 'SIGN_IN_REQUIRED');
      return;
    }
    if (cmd === 'status') {
      console.log((await provider.isSignedIn()) ? 'SIGNED_IN' : 'SIGN_IN_REQUIRED');
      return;
    }
    if (cmd === 'audit') {
      const [business_name, website, location] = args;
      if (!business_name || !website || !location) {
        console.error('usage: audit "<business name>" <website> "<location>"');
        process.exitCode = 2;
        return;
      }
      const engine = new AuditEngine({ provider, evidence, store, log });
      const record = newAuditRecord({ business_name, website, location }, provider.name);
      await store.save(record);
      await engine.run(record);
      console.log(JSON.stringify(summarise(record), null, 2));
      return;
    }
    console.error('commands: connect | status | audit');
    process.exitCode = 2;
  } finally {
    await provider.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
