/**
 * API to add a work item
 */
import validate from 'express-validation';
import _ from 'lodash';
import config from 'config';
import Joi from 'joi';

import models from '../../models';
import util from '../../util';
import { EVENT } from '../../constants';

const permissions = require('tc-core-library-js').middleware.permissions;

const schema = {
  params: {
    projectId: Joi.number().integer().positive().required(),
    workStreamId: Joi.number().integer().positive().required(),
    workId: Joi.number().integer().positive().required(),
  },
  body: {
    param: Joi.object().keys({
      name: Joi.string().required(),
      type: Joi.string().required(),
      templateId: Joi.number().positive().optional(),
      directProjectId: Joi.number().positive().optional(),
      billingAccountId: Joi.number().positive().optional(),
      estimatedPrice: Joi.number().positive().optional(),
      actualPrice: Joi.number().positive().optional(),
      details: Joi.any().optional(),
    }).required(),
  },
};

module.exports = [
  // validate request payload
  validate(schema),
  // check permission
  permissions('workItem.create'),
  // do the real work
  (req, res, next) => {
    const projectId = _.parseInt(req.params.projectId);
    const workStreamId = _.parseInt(req.params.workStreamId);
    const phaseId = _.parseInt(req.params.workId);

    const data = req.body.param;
    // default values
    _.assign(data, {
      projectId,
      phaseId,
      createdBy: req.authUser.userId,
      updatedBy: req.authUser.userId,
    });

    let newPhaseProduct = null;
    models.sequelize.transaction(() => models.ProjectPhase.findOne({
      where: {
        id: phaseId,
        projectId,
      },
      include: [{
        model: models.WorkStream,
        where: {
          id: workStreamId,
          projectId,
        },
      }],
    }).then((existing) => {
      // make sure work stream exists
      if (!existing) {
        const err = new Error(`project work stream not found for project id ${projectId}` +
          ` and work stream ${workStreamId} and phase id ${phaseId}`);
        err.status = 404;
        throw err;
      }

      return models.Project.findOne({
        where: { id: projectId, deletedAt: { $eq: null } },
        raw: true,
      });
    })
    .then((existingProject) => {
      // make sure project exists
      if (!existingProject) {
        const err = new Error(`project not found for project id ${projectId}`);
        err.status = 404;
        throw err;
      }

      _.assign(data, {
        phaseId,
        projectId,
        directProjectId: existingProject.directProjectId,
        billingAccountId: existingProject.billingAccountId,
      });

      return models.PhaseProduct.count({
        where: {
          projectId,
          phaseId,
          deletedAt: { $eq: null },
        },
        raw: true,
      });
    })
    .then((productCount) => {
      // make sure number of products of per phase <= max value
      if (productCount >= config.maxPhaseProductCount) {
        const err = new Error('the number of products per phase cannot exceed ' +
          `${config.maxPhaseProductCount}`);
        err.status = 400;
        throw err;
      }
      return models.PhaseProduct.create(data)
      .then((_newPhaseProduct) => {
        newPhaseProduct = _.cloneDeep(_newPhaseProduct);
        req.log.debug('new work created (id# %d, name: %s)',
          newPhaseProduct.id, newPhaseProduct.name);
        newPhaseProduct = newPhaseProduct.get({ plain: true });
        newPhaseProduct = _.omit(newPhaseProduct, ['deletedAt', 'utm']);
      });
    }))
    .then(() => {
      // Send events to buses
      req.log.debug('Sending event to RabbitMQ bus for phase product %d', newPhaseProduct.id);
      req.app.services.pubsub.publish(EVENT.ROUTING_KEY.PROJECT_PHASE_PRODUCT_ADDED,
        newPhaseProduct,
        { correlationId: req.id },
      );
      req.log.debug('Sending event to Kafka bus for phase product %d', newPhaseProduct.id);
      req.app.emit(EVENT.ROUTING_KEY.PROJECT_PHASE_PRODUCT_ADDED, { req, created: newPhaseProduct });

      res.status(201).json(util.wrapResponse(req.id, newPhaseProduct, 1, 201));
    })
    .catch((err) => { next(err); });
  },
];
