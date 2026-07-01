import { describe, it, expect } from 'vitest';
import { safeLog } from '../../../src/lib/logger.js';

describe('safeLog', () => {
  it('masks CPF in string values (formatted)', () => {
    const result = safeLog({ msg: 'paciente 123.456.789-09 atendido' });
    expect(result.msg).toBe('paciente ***.456.789-** atendido');
  });

  it('masks CPF in string values (unformatted 11 digits)', () => {
    const result = safeLog({ msg: 'cpf 12345678901 encontrado' });
    expect(result.msg).toBe('cpf ***.456.789-** encontrado');
  });

  it('redacts fields named cpf', () => {
    const result = safeLog({ cpf: '123.456.789-09' });
    expect(result.cpf).toBe('***REDACTED***');
  });

  it('redacts fields named documento', () => {
    const result = safeLog({ documento: '12345678901' });
    expect(result.documento).toBe('***REDACTED***');
  });

  it('preserves non-sensitive fields', () => {
    const result = safeLog({ stepId: 'step-123', attempt: 1 });
    expect(result.stepId).toBe('step-123');
    expect(result.attempt).toBe(1);
  });

  it('recurses into nested objects', () => {
    const result = safeLog({ patient: { cpf: '123.456.789-09', name: 'Test' } });
    expect((result.patient as Record<string, unknown>).cpf).toBe('***REDACTED***');
    expect((result.patient as Record<string, unknown>).name).toBe('Test');
  });

  it('handles arrays', () => {
    const result = safeLog({ msgs: ['cpf 12345678901 ok'] });
    expect((result.msgs as string[])[0]).toBe('cpf ***.456.789-** ok');
  });
});
