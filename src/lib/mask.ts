const CPF_REGEX = /\b(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})\b/g;

export function maskCpf(value: string): string {
  return value.replace(CPF_REGEX, (_match, _g1: string, g2: string, g3: string, _g4: string) => {
    return `***.${g2}.${g3}-**`;
  });
}
