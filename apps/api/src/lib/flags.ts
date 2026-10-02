import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { Errors } from './errors.js';

/**
 * Switches for features that are built but not yet turned on.
 *
 * Every one defaults to off. With a feature off, its screens are hidden and
 * its API routes answer 404 as if they did not exist, and nothing else in the
 * app behaves differently. Turning one on is a deliberate, separate decision
 * (an environment variable on the API), never a side effect of a deploy.
 */
export interface FeatureFlags {
  multiLegTrips: boolean;
  departmentScoping: boolean;
  foodOps: boolean;
}

export function featureFlags(): FeatureFlags {
  return {
    multiLegTrips: env.MULTI_LEG_TRIPS_ENABLED,
    departmentScoping: env.DEPARTMENT_SCOPING_ENABLED,
    foodOps: env.FOOD_OPS_ENABLED,
  };
}

export function isOn(flag: keyof FeatureFlags): boolean {
  return Boolean(featureFlags()[flag]);
}

/** Route guard: answers 404 while the feature is off. Put it AFTER the role
 *  guard, so a person without the role is refused (403) whatever the flag. */
export function requireFlag(flag: keyof FeatureFlags) {
  return async function flagGuard(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!isOn(flag)) throw Errors.notFound('Page');
  };
}
