import { describe, it, expect } from 'vitest';
import { normalizeAdvertisedSchema } from '../../src/server.js';

/**
 * Issue #55 follow-up: the tools/list normalizer rewrites `additionalProperties: {}` to the
 * boolean form Home Assistant's converter accepts. The rewrite keys on the property name, so
 * it has to know when that name is a JSON Schema keyword and when it is just a field a tool
 * happens to declare -- inside a `properties` map the keys are user field names, and a boolean
 * there is not merely useless but strictly worse: voluptuous-openapi's converter opens with
 * `if not isinstance(schema, dict): raise ValueError("Invalid schema, expected a dictionary")`,
 * so it accepts a boolean only under `additionalProperties`, which it special-cases and never
 * recurses into.
 */
describe('normalizeAdvertisedSchema', () => {
  it('does not rewrite a declared property that is named additionalProperties', () => {
    const schema = {
      type: 'object',
      properties: {
        additionalProperties: {},
      },
    };

    expect(normalizeAdvertisedSchema(schema)).toEqual(schema);
  });

  it('does not rewrite a $defs member that is named additionalProperties', () => {
    const schema = {
      type: 'object',
      $defs: {
        additionalProperties: {},
      },
    };

    expect(normalizeAdvertisedSchema(schema)).toEqual(schema);
  });

  it('does not rewrite keyword-shaped keys inside a default value', () => {
    const schema = {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          additionalProperties: {},
          default: { additionalProperties: {}, $schema: 'http://json-schema.org/draft-07/schema#' },
        },
      },
    };

    const result = normalizeAdvertisedSchema(schema) as typeof schema;

    expect(result.properties.payload.additionalProperties).toBe(true);
    expect(result.properties.payload.default).toEqual({
      additionalProperties: {},
      $schema: 'http://json-schema.org/draft-07/schema#',
    });
  });

  it('still rewrites the additionalProperties keyword nested under a declared property', () => {
    const schema = {
      type: 'object',
      properties: {
        config: { type: 'object', additionalProperties: {} },
      },
    };

    const result = normalizeAdvertisedSchema(schema) as {
      properties: { config: { additionalProperties: unknown } };
    };

    expect(result.properties.config.additionalProperties).toBe(true);
  });

  it('still relabels the draft-07 dialect stamp', () => {
    const result = normalizeAdvertisedSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
    }) as { $schema: string };

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('leaves a non-empty additionalProperties schema alone', () => {
    const schema = { type: 'object', additionalProperties: { type: 'boolean' } };

    expect(normalizeAdvertisedSchema(schema)).toEqual(schema);
  });
});
