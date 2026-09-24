import { conflict, notFound } from '@core/errors';
import { LOG_DOMAINS, logger } from '@core/logger';

import { authService } from '../auth/auth.service';
import { onboardingRepo } from './onboarding.repo';
import type { User } from '../auth/types';

const onboardingLogger = logger.child({ domain: LOG_DOMAINS.AUTH });

export const onboardingService = {
  async join(userId: string, companyId: string): Promise<User> {
    const result = await onboardingRepo.joinCompany(userId, companyId);
    if (result === 'not_onboarding') {
      throw conflict('onboarding.already_completed', 'Onboarding has already been completed');
    }
    if (result === 'company_not_found') {
      throw notFound('companies.not_found', `Company "${companyId}" was not found`);
    }
    onboardingLogger.info('onboarding completed via join', { userId, companyId });
    return authService.getProfile(userId);
  },

  async create(userId: string, name: string): Promise<User> {
    const result = await onboardingRepo.createAndJoinCompany(userId, name);
    if (result === 'not_onboarding') {
      throw conflict('onboarding.already_completed', 'Onboarding has already been completed');
    }
    onboardingLogger.info('onboarding completed via create', { userId });
    return authService.getProfile(userId);
  },
};
