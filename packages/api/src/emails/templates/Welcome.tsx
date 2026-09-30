import { Body, Container, Heading, Html, Text } from '@react-email/components';

interface WelcomeProps {
  name: string;
}

export default function Welcome({ name }: WelcomeProps) {
  return (
    <Html>
      <Body>
        <Container>
          <Heading>Welcome, {name}</Heading>
          <Text>Thanks for joining Canyon Code.</Text>
        </Container>
      </Body>
    </Html>
  );
}
