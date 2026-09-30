import { config } from '@core/env';
import { initLogger } from '@core/logger';

import { startApi } from './app';

initLogger();
void startApi({ host: config.app.host, port: config.app.port });
