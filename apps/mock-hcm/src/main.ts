import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

async function bootstrap() {
  const app = await NestFactory.create(MockHcmModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const port = Number(process.env.MOCK_HCM_PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[mock-hcm] listening on http://localhost:${port}`);
}
void bootstrap();
