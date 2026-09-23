import { config } from '@core/env';
import { initLogger } from '@core/logger';

import { startApi } from './app';
import { install_test_workflow_generation } from './modules/workflows/workflows.generation.testkit';

initLogger();
// UI E2E boots the API via this entry (`bun run dev`); wire the fixed stub graph so uploads yield
// a design the specs can assert against. Installs only under NODE_ENV=test or a non-production
// WORKFLOW_GENERATION_STUB=true — never in production.
install_test_workflow_generation();
void startApi({ host: config.app.host, port: config.app.port });
