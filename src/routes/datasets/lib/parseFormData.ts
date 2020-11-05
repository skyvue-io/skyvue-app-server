import { IBoardData } from '../../../types';
import {v4 as uuidv4} from 'uuid';
import * as R from 'ramda';
import parseDataType from './parseDataType';


const parseFormData = (fileName: string, userId: string, csvAsJson: Array<any>): IBoardData => ({
  title: fileName,
  visibilitySettings: {
    owner: userId,
    editors: [userId],
    viewers: [],
  },
  columns: Object.keys(csvAsJson[0]).map(key => ({
    _id: uuidv4(),
    value: key,
    dataType: parseDataType(csvAsJson[0][key]),
  })),
  rows: csvAsJson.map(row => ({
    _id: uuidv4(),
    cells: R.pipe(
      R.values,
      R.map(row => ({
        _id: uuidv4(),
        value: row,
      }))
    )(row)
  })),
})

export default parseFormData;