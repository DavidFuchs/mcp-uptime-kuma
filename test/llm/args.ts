import type { Scenario } from './scenario.js';

export interface LlmArgs {
  scenarios: string[];
  tags: string[];
  repeat: number;
  model: string;
  minPassRate: number;
  keepTraces: boolean;
}

export const USAGE = `Usage: npm run test:llm -- [options]
  --scenario <id>        run only this scenario (repeatable)
  --tag <tag>            run only scenarios with this tag (repeatable)
  --repeat <n>           runs per scenario (default 1)
  --model <alias>        claude model (default sonnet)
  --min-pass-rate <0..1> per-scenario pass rate required to exit 0 (default 1)
  --keep-traces          keep raw traces for passing runs too`;

export function parseArgs(argv: string[]): LlmArgs {
  const a: LlmArgs = { scenarios: [], tags: [], repeat: 1, model: 'sonnet', minPassRate: 1, keepTraces: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n\n${USAGE}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--scenario':
        a.scenarios.push(value(i++, flag));
        break;
      case '--tag':
        a.tags.push(value(i++, flag));
        break;
      case '--model':
        a.model = value(i++, flag);
        break;
      case '--keep-traces':
        a.keepTraces = true;
        break;
      case '--repeat': {
        const n = Number(value(i++, flag));
        if (!Number.isInteger(n) || n < 1) throw new Error(`--repeat must be a whole number of at least 1\n\n${USAGE}`);
        a.repeat = n;
        break;
      }
      case '--min-pass-rate': {
        const r = Number(value(i++, flag));
        if (!Number.isFinite(r) || r < 0 || r > 1)
          throw new Error(`--min-pass-rate must be between 0 and 1\n\n${USAGE}`);
        a.minPassRate = r;
        break;
      }
      default:
        throw new Error(`Unknown option: ${flag}\n\n${USAGE}`);
    }
  }
  return a;
}

export function selectScenarios(all: Scenario<any>[], a: LlmArgs): Scenario<any>[] {
  const unknown = a.scenarios.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown scenario: ${unknown.join(', ')}. Available: ${all.map((s) => s.id).join(', ')}`);
  }
  return all.filter(
    (s) =>
      (a.scenarios.length === 0 || a.scenarios.includes(s.id)) &&
      (a.tags.length === 0 || a.tags.some((t) => s.tags.includes(t)))
  );
}
