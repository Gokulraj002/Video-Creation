import type { FastifyInstance } from 'fastify';
import type { MeDTO } from '@vc/schema';
import { toMeDto } from '../lib/dto';
import { requireUser } from '../plugins/auth';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (request): Promise<MeDTO> => toMeDto(requireUser(request)));
}
