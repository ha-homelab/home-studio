import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { ValidationError } from '../planner/validation.js';
import { fuzz, assertExpectedValidationError } from './project-validation.mjs';

test('all synthetic corpus inputs replay without false findings', () => {
  const corpus = new URL('./corpus/project-validation/', import.meta.url);
  for (const name of readdirSync(corpus)) fuzz(readFileSync(new URL(name, corpus)));
});

test('localized and ordinary validation errors are deliberate rejections', () => {
  assertExpectedValidationError(new Error('Invalid project'));
  assertExpectedValidationError(new ValidationError('Invalid project'));
});

test('runtime errors and unexpected subclasses remain findings', () => {
  class UnexpectedValidationError extends ValidationError {}
  for (const error of [
    new TypeError('Bad access'), new RangeError('Bad range'),
    new assert.AssertionError({ message: 'Failed invariant' }),
    new UnexpectedValidationError('Unexpected subtype'),
    { message: 'Not an Error' }, null, new Error(''),
  ]) assert.throws(() => assertExpectedValidationError(error));
});
