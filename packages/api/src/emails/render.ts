import { render } from '@react-email/render';
import { createElement } from 'react';

import Welcome from './templates/Welcome';

export async function renderWelcomeEmail(props: { name: string }): Promise<string> {
  return render(createElement(Welcome, props));
}
