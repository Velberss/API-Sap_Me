import { Router } from 'express';

import { SapController } from '../controllers/sap.controller.js';
import { makeSapDependencies } from '../../infrastructure/http/sap-dependencies.factory.js';

const { knowledgeSearchUseCase } = makeSapDependencies();
const sapController = new SapController(knowledgeSearchUseCase);

export const sapRouter = Router();

sapRouter.post('/search', sapController.knowledgeSearch);
