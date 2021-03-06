import express from 'express';
import csv from 'csvtojson';
import expressUpload from 'express-fileupload';
import aws from 'aws-sdk';
import * as R from 'ramda';
import { AuthenticatedRoute } from 'types/requestTypes';
import { v4 as uuid } from 'uuid';
import datasetService from '../../services/datasetService';
import authCheck from '../../middleware/authCheck';
import parseFormData from './lib/parseFormData';
import Dataset from '../../models/dataset';

const router = express.Router();

const s3 = new aws.S3({
  region: 'us-east-2',
  accessKeyId: process.env.AWS_ACCESSKEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESSKEY,
});

router.use(authCheck);
router.use(expressUpload());

router.get('/', async (req: AuthenticatedRoute, res) => {
  const datasets = await Dataset.find({
    userId: req.user?._id.toString(),
  })
    .lean()
    .exec();

  return res.json(datasets);
});

router.post('/make_dataset_upload_url', async (req: AuthenticatedRoute, res) => {
  const { title } = req.body;
  const userId = req.user._id;

  const dataset = new Dataset({
    userId,
    title,
    visibilitySettings: {
      owner: userId,
      editors: [userId],
      viewers: [],
    },
  });

  s3.createPresignedPost(
    {
      Fields: {
        key: `${dataset._id}/0`,
      },
      Conditions: [['starts-with', '$Content-Type', 'text/']],
      Expires: 3600,
      Bucket: 'skyvue-datasets-queue',
    },
    async (error, signed) => {
      if (error) {
        return res.status(500).json({ error: 'Upload error' });
      }

      await dataset.save();
      res.json(signed);
    },
  );
});

router.post(
  '/make_dataset_append_url/:datasetId',
  async (req: AuthenticatedRoute, res) => {
    const { datasetId } = req.params;

    s3.createPresignedPost(
      {
        Fields: {
          key: `${datasetId}/0`,
        },
        Conditions: [['starts-with', '$Content-Type', 'text/']],
        Expires: 30,
        Bucket: 'skyvue-datasets-appends',
      },
      async (error, signed) => {
        if (error) {
          return res.status(500).json({ error: 'Upload error' });
        }

        res.json(signed);
      },
    );
  },
);

router.post('/make_dataset_preview_url', async (req: AuthenticatedRoute, res) => {
  const _id = uuid();
  s3.createPresignedPost(
    {
      Fields: {
        key: _id,
      },
      Conditions: [['starts-with', '$Content-Type', 'text/']],
      Expires: 30,
      Bucket: 'skyvue-upload-previews',
    },
    async (error, signed) => {
      if (error) {
        return res.status(500).json({ error: 'Upload error' });
      }

      res.json({
        _id,
        ...signed,
      });
    },
  );
});

router.post('/process_dataset', async (req: AuthenticatedRoute, res) => {
  const { body } = req;
  const { key } = body;
  if (!key) return res.sendStatus(400);

  try {
    res.sendStatus(200);

    await datasetService.post('/datasets/process_dataset', {
      key,
      userId: req.user._id,
    });
  } catch (e) {
    console.error('error in processing dataset', e);
    res.sendStatus(500);
  }
});

router.get('/:datasetId', async (req: AuthenticatedRoute, res) => {
  const { datasetId } = req.params;
  try {
    const dataset = await Dataset.findById(datasetId).lean().exec();
    const s3Params = {
      Bucket: 'skyvue-datasets',
      Key: `${datasetId.toString()}/columns/0`,
    };
    const head = await s3.headObject(s3Params).promise();
    res.json({ dataset, head });
  } catch (e) {
    res.status(404).json({});
  }
});

router.patch('/:datasetId', async (req: AuthenticatedRoute, res) => {
  try {
    await Dataset.findByIdAndUpdate(req.params.datasetId, req.body).lean().exec();
  } catch (e) {
    return res.status(400).json({ error: e });
  }
  return res.sendStatus(200);
});

router.delete('/:datasetId', async (req: AuthenticatedRoute, res) => {
  try {
    await Dataset.findByIdAndDelete(req.params.datasetId).lean().exec();
    const s3Params = {
      Bucket: 'skyvue-datasets',
      Key: req.params.datasetId.toString(),
    };
    await s3.deleteObject(s3Params).promise();

    return res.sendStatus(200);
  } catch (e) {
    return res.sendStatus(400);
  }
});

// deprecated
router.post('/duplicate/:datasetId', async (req: AuthenticatedRoute, res) => {
  const { newTitle, raw } = req.body;
  const { datasetId } = req.params;

  if (!datasetId || !req.user._id) res.sendStatus(400);

  const current = await Dataset.findById(datasetId).lean().exec();
  const newDataset = new Dataset({
    userId: req.user._id,
    title: newTitle ?? `${current.title} (copy)`,
    visibilitySettings: {
      owner: req.user._id,
    },
  });

  await newDataset.save();

  if (raw) {
    const s3Params = {
      Bucket: 'skyvue-datasets',
      Key: current._id.toString(),
    };
    const s3Res = await s3.getObject(s3Params).promise();
    const currentBoardData = JSON.parse(s3Res.Body.toString('utf-8'));

    try {
      await s3
        .putObject({
          ...s3Params,
          Key: newDataset._id.toString(),
          Body: JSON.stringify(R.omit(['title'], currentBoardData)),
          ContentType: 'application/json',
        })
        .promise();
    } catch (e) {
      console.log(e);
      return res.sendStatus(400);
    }
  }

  res.json(newDataset);
});

module.exports = router;
