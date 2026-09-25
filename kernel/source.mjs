// Trusted scaffold: candidates select a closed implementation, never source text.
// This exact signature and postcondition are shared by every generated variant.
export const CONTRACT = `pub fn compact(
    revision: u64,
    base_revision: u64,
    retained: u64,
    required: u64,
    proposed: u64,
) -> (out: (u64, u64, bool))
    ensures
        out.2 == (
            base_revision == revision
            && revision < u64::MAX
            && (proposed & retained) == proposed
            && (proposed & required) == required
        ),
        out.2 ==> out.0 as int == revision as int + 1,
        out.2 ==> out.1 == proposed,
        out.2 ==> (out.1 & required) == required,
        out.2 ==> (out.1 & retained) == out.1,
        !out.2 ==> out.0 == revision,
        !out.2 ==> out.1 == retained,
`;

const guards = new Map([
  ['original', [
    'base_revision == revision',
    'revision < u64::MAX',
    '(proposed & retained) == proposed',
    '(proposed & required) == required',
  ]],
  ['drop-required', [
    'base_revision == revision',
    'revision < u64::MAX',
    '(proposed & retained) == proposed',
  ]],
  ['reorder', [
    '(proposed & required) == required',
    '(proposed & retained) == proposed',
    'revision < u64::MAX',
    'base_revision == revision',
  ]],
  ['drop-revision', [
    'revision < u64::MAX',
    '(proposed & retained) == proposed',
    '(proposed & required) == required',
  ]],
]);

// Outside verus!: this adapter parses input and prints the actual native result.
// Neither the adapter nor JavaScript decides whether a compaction is accepted.
const CLI = String.raw`
fn parse_u64(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err("expected a canonical unsigned decimal u64".to_string());
    }
    value.parse::<u64>().map_err(|_| "u64 out of range".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        eprintln!("usage: kernel-native REVISION BASE_REVISION RETAINED REQUIRED PROPOSED");
        std::process::exit(2);
    }
    let values: Result<Vec<u64>, _> = args.iter().map(|arg| parse_u64(arg)).collect();
    let values = match values {
        Ok(values) => values,
        Err(error) => {
            eprintln!("invalid input: {error}");
            std::process::exit(2);
        }
    };
    let (revision, retained, accepted) = compact(
        values[0], values[1], values[2], values[3], values[4],
    );
    println!(
        "{{\"revision\":\"{revision}\",\"retained\":\"{retained}\",\"accepted\":{accepted}}}"
    );
}
`;

export const CANDIDATE_VARIANTS = Object.freeze([
  'drop-required', 'reorder', 'reject-all', 'drop-revision',
]);

export function generateSource(variant) {
  if (variant !== 'reject-all' && !guards.has(variant)) {
    throw new TypeError('unknown kernel variant');
  }
  const body = variant === 'reject-all'
    ? '{\n    (revision, retained, false)\n}\n'
    : `{
    if ${guards.get(variant).join('\n        && ')}
    {
        (revision + 1, proposed, true)
    } else {
        (revision, retained, false)
    }
}
`;
  return '// Generated from the fixed Veri-Watch contract and a closed guard variant.\n'
    + 'use vstd::prelude::*;\n\nverus! {\n\n' + CONTRACT + body + '\n}\n' + CLI;
}
