/**
 * Module dependencies
 */

var _ = require('lodash');
var utils = require('./utils');
var hop = utils.object.hasOwnProperty;
var operators = [
  '<',
  'lessThan',
  '<=',
  'lessThanOrEqual',
  '>',
  'greaterThan',
  '>=',
  'greaterThanOrEqual',
  '!',
  'not',
  'like',
  'contains',
  'startsWith',
  'endsWith'
];

/**
 * Process Criteria
 *
 * Processes a query criteria object
 */

var CriteriaProcessor = module.exports = function CriteriaProcessor(currentTable, schema, options) {
  if(!currentTable || !schema) {
    throw new Error('Incorrect usage of CriteriaProcessor. Must include the currentTable and schema arguments.');
  }
  this.currentTable = currentTable;
  this.schema = schema;
  // this.currentSchema = schema[currentTable].attributes;
  this.currentSchema = schema;
  this.tableScope = null;
  this.queryString = "";
  this.values = [];
  this.paramCount = 1;
  this.parameterized = true;
  this.caseSensitive = true;
  this.escapeCharacter = "`";
  this.wlNext = {};

  if(options && utils.object.hasOwnProperty(options, 'parameterized')) {
    this.parameterized = options.parameterized;
  }

  if(options && utils.object.hasOwnProperty(options, 'caseSensitive')) {
    this.caseSensitive = options.caseSensitive;
  }

  if(options && utils.object.hasOwnProperty(options, 'escapeCharacter')) {
    this.escapeCharacter = options.escapeCharacter;
  }

  if(options && utils.object.hasOwnProperty(options, 'paramCount')) {
    this.paramCount = options.paramCount;
  }

  if(options && utils.object.hasOwnProperty(options, 'wlNext')) {
    this.wlNext = options.wlNext;
  }

  if(options && hop(options, 'schemaName')) {
    this.schemaName = options.schemaName;
  }

  return this;
};


/**
 * Read criteria object and expand it into a sequel string.
 *
 * @param {Object} options
 */

CriteriaProcessor.prototype.read = function read(options) {
  var self = this;
  var _options;

  this.joins = [];

  if(options.where) {
    _options = options.where;
  }
  else {
    _options = _.cloneDeep(options);
  }

  // Remove SUM, AVERAGE, MAX, MIN
  delete _options.sum;
  delete _options.average;
  delete _options.max;
  delete _options.min;
  delete _options.groupBy;
  delete _options.limit;
  delete _options.skip;
  delete _options.sort;

  if(_options.where !== null) {
    _.each(_.keys(_options), function(key) {
      self.expand(key, _options[key]);
    });
  }

  // Remove trailing 'AND'
  this.queryString = this.queryString.slice(0, -4);

  if(options.groupBy) this.group(options.groupBy);
  if(options.sort) this.sort(options.sort);
  if(hop(options, 'limit')) this.limit(options.limit);

  // Ensure a limit was used if skip was used
  if(hop(options, 'skip') && !hop(options, 'limit')) {
    this.limit(null);
  }

  if(hop(options, 'skip')) this.skip(options.skip);

  return {
    query: this.queryString,
    values: this.values,
    joins: this.joins,
    useConcat: this.useConcat
  };
};


/**
 * Expand a criteria piece.
 *
 * Given a key on a criteria object, expand it into it's sequel parts by inspecting which type
 * of operator to use (`or`, `and`, `in` or `like`) and then recursively process that key if needed.
 *
 * @param {String} key
 * @param {String || Object} val
 * @return
 */

CriteriaProcessor.prototype.expand = function expand(key, val) {
  var self = this;

  switch(key.toLowerCase()) {
    case 'concat':
      self.concatenate(val);
      return;

    case 'or':
      self.or(val);
      return;

    case 'like':
      self.like(val);
      return;

    // Key/Value
    default:

      // `IN`
      if(Array.isArray(val)) {
        self._in(key, val);
        return;
      }

      // `AND`
      self.and(key, val);
      return;
  }
};


/**
 * Handle `concat` Criteria
 */

CriteriaProcessor.prototype.concatenate = function or(val) {
  var self = this;
  var currentSchema = this.schema;
  var value = val.contains || val.startsWith || val.startWith || val.endsWith || val.endWith || val.equal;
  var tableName = this.getTableAlias();
  var concatParams = [];

  value = utils.escapeString(value);

  this.queryString += '(CONCAT(';

  val.fields.forEach((field, index)=> {
    let parent = field;
    var split = field.split('.');

    if (split.length > 1) {
      var propertySchema = currentSchema[_.first(split)];
      tableName = propertySchema.alias;
      parent = _.last(split);

      this.joins.push(propertySchema);
    }

    field =  'TRIM(' + tableName + "." + parent + ')';
    concatParams.push(field);

    if ((index + 1) !== val.fields.length) {
      concatParams.push("'" + val.separator + "'");
    }
  });

  this.queryString += concatParams.join(', ');

  this.queryString += ')';

  if (val.contains) {
    this.queryString += " LIKE '%" + value + "%'";
  }
  else if (val.startsWith || val.startWith) {
    this.queryString += " LIKE '%" + value + "'";
  }
  else if (val.endsWith || val.endWith) {
    this.queryString += " LIKE '" + value + "%'";
  }
  else if (val.equal) {
    this.queryString += " = '" + value + "'";
  }

  this.queryString += ') AND ';
  this.useConcat = true;
};

/**
 * Handle `OR` Criteria
 */

CriteriaProcessor.prototype.or = function or(val) {
  var self = this;

  if(!_.isArray(val)) {
    throw new Error('`or` statements must be in an array.');
  }

  // Wrap the entire OR clause
  this.queryString += '(';

  _.each(val, function(statement) {
    self.queryString += '(';

    // Recursively call expand. Assumes no nesting of `or` statements
    _.each(_.keys(statement), function(key) {
      self.expand(key, statement[key]);
    });

    if(self.queryString.slice(-4) === 'AND ') {
      self.queryString = self.queryString.slice(0, -5);
    }

    self.queryString += ') OR ';
  });

  // Remove trailing OR if it exists
  if(self.queryString.slice(-3) === 'OR ') {
    self.queryString = self.queryString.slice(0, -4);
  }

  self.queryString += ') AND ';
};


/**
 * Handle `LIKE` Criteria
 */

CriteriaProcessor.prototype.like = function like(val) {

  var self = this;

  var expandBlock = function(parent) {
    var caseSensitive = true;

    // Check if parent is a string, if so make sure it's case sensitive.
    if(self.currentSchema[parent] &&
        (self.currentSchema[parent] === 'text' ||
         self.currentSchema[parent] === 'string' ||
         self.currentSchema[parent].type === 'string' ||
         self.currentSchema[parent].type === 'text')) {
      caseSensitive = false;
    }

    var comparator = self.caseSensitive ? 'LIKE' : 'LIKE';

    // Override comparator with WL Next features
    if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
      comparator = 'LIKE';
    }

    self.process(parent, val[parent], comparator, caseSensitive);
    self.queryString += ' AND ';
  };

  _.each(_.keys(val), function(parent) {
    expandBlock(parent);
  });

};


/**
 * Handle `AND` Criteria
 */

CriteriaProcessor.prototype.and = function and(key, val) {
  var caseSensitive = true;

  // Check if key is a string
  if(this.currentSchema[key] && this.currentSchema[key] === 'string') {
    caseSensitive = false;
  }
  // Override case sensitive with WL Next features
  if(hop(this.wlNext, 'caseSensitive') && this.wlNext.caseSensitive) {
    caseSensitive = true;
  }

  this.process(key, val, '=', caseSensitive);
  this.queryString += ' AND ';
};

/**
 * Get the current table scope.
 *
 * @returns {string}
 */
CriteriaProcessor.prototype.getTableScope = function () {
  return this.tableScope || this.currentTable;
};

/**
 * Get the alias for the current table scope
 *
 * @returns {string}
 */
CriteriaProcessor.prototype.getTableAlias = function () {
  if (this.tableScope) {
    return utils.populationAlias(this.tableScope)
  }

  return this.currentTable;
};

/**
 * Handle `IN` Criteria
 */

CriteriaProcessor.prototype._in = function _in(key, val) {

  var self = this;

  // Set case sensitive by default
  var caseSensitivity = true;

  // Set lower logic to false
  var lower = false;

  // Check if key is a string
  var schema = self.currentSchema && self.currentSchema[key];
  if(!_.isPlainObject(schema)) {
    schema = { type: schema };
  }

  if(schema && schema.type === 'text' || schema.type === 'string') {
    caseSensitivity = false;
    lower = true;
  }

  // Override caseSensitivity for databases that don't support it
  if(this.caseSensitive) {
    caseSensitivity = false;
  }

  // Add support for overriding case sensitivity with WL Next features
  if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
    caseSensitivity = true;
  }

  // Check case sensitivity to decide if LOWER logic is used
  if(!caseSensitivity) {
    if(lower) {
      key = 'LOWER(' + utils.escapeName(self.getTableAlias(), self.escapeCharacter, self.schemaName) + '.' + utils.escapeName(key, self.escapeCharacter) + ')';
    } else {
      key = utils.escapeName(self.getTableAlias(), self.escapeCharacter, self.schemaName) + '.' + utils.escapeName(key, self.escapeCharacter);
    }
    self.queryString += key + ' IN (';
  } else {
    self.queryString += utils.escapeName(self.getTableAlias(), self.escapeCharacter, self.schemaName) + '.' + utils.escapeName(key, self.escapeCharacter) + ' IN (';
  }

  // Append each value to query
  _.each(val, function(value) {

    // If case sensitivity if off lowercase the value
    if(!caseSensitivity && _.isString(value)) {
      value = value.toLowerCase();
    }

    // Use either a paramterized value or escaped value
    if(self.parameterized) {
      self.queryString += '$' + self.paramCount + ',';
      self.paramCount++;
    }
    else {
      if(_.isString(value)) {
        value = '"' + utils.escapeString(value) + '"';
      }

      self.queryString += value + ',';
    }

    self.values.push(value);
  });

  // Strip last comma and close criteria
  self.queryString = self.queryString.slice(0, -1) + ')';

  self.queryString += ' AND ';
};

/**
 * Build a param.
 *
 * @param {string}  tableName
 * @param {string}  property
 * @param {boolean} caseSensitive
 *
 * @returns {string}
 */
CriteriaProcessor.prototype.buildParam = function buildParam (tableName, property, caseSensitive) {
  var escape = utils.escapeName,
      param;

  param = escape(tableName, this.escapeCharacter, this.schemaName) + '.' + escape(property, this.escapeCharacter);

  if (caseSensitive) {
    param = 'LOWER(' + param + ')';
  }

  return param;
};

/**
 * Simple method which returns if supplied method is, or is not an operator.
 *
 * @param {string} subject
 *
 * @returns {boolean}
 */
CriteriaProcessor.prototype.isOperator = function isOperator (subject) {
  return operators.indexOf(subject) > -1;
};

/**
 * Check if given `child` is in fact a child in the currentSchema, and if so return the key.
 *
 * @param {string} child
 *
 * @returns {boolean}
 */
CriteriaProcessor.prototype.findChild = function findChild (child) {
  var schema        = this.currentSchema,
      definitionKey = schema[child] ? child : _.findKey(schema, {columnName: child});

  return definitionKey && _.isPlainObject(schema[definitionKey]) && schema[definitionKey].foreignKey
    ? definitionKey
    : null;
};



/**
 * Process simple criteria.
 *
 * @param {string}  tableName
 * @param {string}  parent
 * @param {string}  value
 * @param {string}  combinator
 * @param {boolean} [sensitive]
 * @param {string}  [alias]
 */
CriteriaProcessor.prototype.processSimple = function processSimple (tableName, parent, value, combinator, sensitive) {
  // Set lower logic to true
  var sensitiveTypes = ['text', 'string'],
      // currentSchema = this.schema[tableName].definition,
      currentSchema = this.schema,
      self = this,
      parentType,
      lower;

  var split = parent.split('.');

  value = utils.escapeString(value);

  if (split.length > 1) {
    var propertySchema = currentSchema[_.first(split)];
    tableName = propertySchema.alias;
    parent = _.last(split);
    // parent = this.escapeCharacter + _.last(split) + this.escapeCharacter;
    this.joins.push(propertySchema);
  }

  if (currentSchema[parent]) {
    parentType = currentSchema[parent].type || currentSchema[parent];
  }

  lower = parentType && sensitiveTypes.indexOf(parentType) > -1;

  // Check if value is a string and if so add LOWER logic
  // to work with case in-sensitive queries

  if(!sensitive && lower && _.isString(value)) {
    // Add LOWER to parent
    parent = this.buildParam(this.getTableAlias(), parent, true);
    value = "'" + value.toLowerCase() + "'";

  } else {
    // Escape parent
    parent = this.buildParam(tableName, parent);
  }

  if(value === null) {
    return this.queryString += parent + ' IS NULL';
  }
  // Simple Key/Value attributes

  if(self.parameterized) {
    this.queryString += parent + ' ' + combinator + ' $' + this.paramCount;

    if (_.isString(value)) {
      value = "'" +value + "'";
    }

    this.values.push(value);
    this.paramCount++;

    return;
  }

  // Check if the value is a DATE and if it's not a date turn it into one
  if(parentType === 'date' && !_.isDate(value)) {
    value = new Date(value);
  }

  if(_.isDate(value)) {
    var date = value;
    date = date.getFullYear() + '-' +
      ('00' + (date.getMonth()+1)).slice(-2) + '-' +
      ('00' + date.getDate()).slice(-2) + ' ' +
      ('00' + date.getHours()).slice(-2) + ':' +
      ('00' + date.getMinutes()).slice(-2) + ':' +
      ('00' + date.getSeconds()).slice(-2);

    value = date;
  }

  if (_.isString(value)) {
    value = "'" + utils.escapeString(value) + "'";
  }

  this.queryString += parent + ' ' + combinator + ' ' + value;
};

/**
 * Process object criteria.
 *
 * @param {string}  parent
 * @param {string}  value
 * @param {string}  combinator
 * @param {boolean} sensitive
 * @param {string}  [alias]
 */
CriteriaProcessor.prototype.processObject = function processObject (tableName, parent, value, combinator, sensitive) {
  // var currentSchema = this.schema[tableName].definition,
  var currentSchema = this.schema,
      self = this,
      parentType;

  var split = parent.split('.');

  if (split.length > 1) {
    var propertySchema = currentSchema[_.first(split)];
    tableName = propertySchema.alias;
    parent = _.last(split);
    this.joins.push(propertySchema);
  }

  expandCriteria(value);

  // Remove trailing `AND`
  this.queryString = this.queryString.slice(0, -4);

  // Expand criteria object
  function expandCriteria (obj) {
    var child = self.findChild(parent),
        sensitiveTypes = ['text', 'string'], // haha, "sensitive types". "I'll watch 'the notebook' with you, babe."
        lower;

    _.each(_.keys(obj), function(key) {
      if (child && !self.isOperator(key)) {
        self.tableScope = child;
        self.expand(key, obj[key]);
        self.tableScope = null;

        return;
      }

      // If value is an object, recursivly expand it
      if(_.isPlainObject(obj[key])) {
        return expandCriteria(obj[key]);
      }

      if (currentSchema[parent]) {
        parentType = currentSchema[parent].type || currentSchema[parent]
      }

      lower = parentType && sensitiveTypes.indexOf(parentType) > -1;

      if (!sensitive && _.isString(obj[key]) && lower) {
        obj[key] = obj[key].toLowerCase();
      }

      // Check if the value is a DATE and if it's not a date turn it into one
      if(parentType === 'date' && !_.isDate(obj[key])) {
        var date = new Date(obj[key]);
        date = date.getFullYear() + '-' +
          ('00' + (date.getMonth()+1)).slice(-2) + '-' +
          ('00' + date.getDate()).slice(-2) + ' ' +
          ('00' + date.getHours()).slice(-2) + ':' +
          ('00' + date.getMinutes()).slice(-2) + ':' +
          ('00' + date.getSeconds()).slice(-2);

        obj[key] = date;
      }

      // Check if value is a string and if so add LOWER logic
      // to work with case in-sensitive queries
      self.queryString += self.buildParam(tableName, parent, !sensitive && _.isString(obj[key]) && lower) + ' ';
      self.prepareCriterion(key, obj[key]);
      self.queryString += ' AND ';
    });
  }
};


/**
 * Process Criteria
 */

CriteriaProcessor.prototype.process = function process(parent, value, combinator, caseSensitive) {
  var tableName = this.getTableScope();

  // Override caseSensitivity for databases that don't support it
  if(this.caseSensitive) {
    caseSensitive = false;
  }

  // Add support for overriding case sensitivity with WL Next features
  if(hop(this.wlNext, 'caseSensitive') && this.wlNext.caseSensitive) {
    caseSensitive = true;
  }

  var processMethod = _.isPlainObject(value) ? this.processObject : this.processSimple;
  processMethod.apply(this, [tableName, parent, value, combinator, caseSensitive]);
};


/**
 * Prepare Criterion
 *
 * Processes comparators in a query.
 */

CriteriaProcessor.prototype.prepareCriterion = function prepareCriterion(key, value) {
  var self = this;
  var str;
  var comparator;
  var escapedDate = false;
  var bumpParamCount = true;

  // Check value for a date type
  if(_.isDate(value)) {
    value = value.getFullYear() + '-' +
      ('00' + (value.getMonth()+1)).slice(-2) + '-' +
      ('00' + value.getDate()).slice(-2) + ' ' +
      ('00' + value.getHours()).slice(-2) + ':' +
      ('00' + value.getMinutes()).slice(-2) + ':' +
      ('00' + value.getSeconds()).slice(-2);

    value = '"' + value + '"';
    escapedDate = true;
  }

  switch(key) {

    case '<':
    case 'lessThan':

      if(this.parameterized) {
        this.values.push(value);
        str = '< ' + '$' + this.paramCount;
      }
      else {
        if(_.isString(value) && !escapedDate) {
          value = '"' + utils.escapeString(value) + '"';
        }
        str = '< ' + value;
      }

      break;

    case '<=':
    case 'lessThanOrEqual':

      if(this.parameterized) {
        this.values.push(value);
        str = '<= ' + '$' + this.paramCount;
      }
      else {
        if(_.isString(value) && !escapedDate) {
          value = '"' + utils.escapeString(value) + '"';
        }
        str = '<= ' + value;
      }

      break;

    case '>':
    case 'greaterThan':

      if(this.parameterized) {
        this.values.push(value);
        str = '> ' + '$' + this.paramCount;
      }
      else {
        if(_.isString(value) && !escapedDate) {
          value = '"' + utils.escapeString(value) + '"';
        }
        str = '> ' + value;
      }

      break;

    case '>=':
    case 'greaterThanOrEqual':

      if(this.parameterized) {
        this.values.push(value);
        str = '>= ' + '$' + this.paramCount;
      }
      else {
        if(_.isString(value) && !escapedDate) {
          value = '"' + utils.escapeString(value) + '"';
        }
        str = '>= ' + value;
      }

      break;

    case '!':
    case 'not':
      if(value === null) {
        str = 'IS NOT NULL';
        bumpParamCount = false;
      }
      else {
        // For array values, do a "NOT IN"
        if (_.isArray(value)) {

          if(self.parameterized) {
            var params = [];

            this.values = this.values.concat(value);
            str = 'NOT IN (';

            _.each(value, function() {
              params.push('$' + self.paramCount++);
            });

            str += params.join(',') + ')';

            // Roll back one since we bump the count at the end
            this.paramCount--;
          }
          else {
            str = 'NOT IN (';
            _.each(value, function(val) {

              if(_.isString(val)) {
                val = '"' + utils.escapeString(val) + '"';
              }

              str += val + ',';
            });

            str = str.slice(0, -1) + ')';
          }
        }
        // Otherwise do a regular <>
        else {

          if(this.parameterized) {
            this.values.push(value);
            str = '<> ' + '$' + this.paramCount;
          }
          else {
            if(_.isString(value)) {
              value = '"' + utils.escapeString(value) + '"';
            }

            str = '<> ' + value;
          }
        }
      }

      break;

    case 'like':

      if(this.caseSensitive) {
        comparator = 'LIKE';
      }
      else {
        comparator = 'LIKE';
      }

      // Override comparator with WL Next features
      if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
        comparator = 'LIKE';
      }

      if(this.parameterized) {
        this.values.push(value);
        str = comparator + " '" + '$' + this.paramCount + "'";
      }
      else {
        // Note that wildcards are not escaped out of like criterion intentionally
        str = comparator + " '" + utils.escapeString(value) + "'";
      }

      break;

    case 'contains':

      if(this.caseSensitive) {
        comparator = 'LIKE';
      }
      else {
        comparator = 'LIKE';
      }

      // Override comparator with WL Next features
      if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
        comparator = 'LIKE';
      }

      if(this.parameterized) {
        this.values.push('%' + utils.escapeString(value) + '%');
        str = comparator + " '" + '$' + this.paramCount + "'";
      }
      else {
        str = comparator + " '%" + utils.escapeString(value, true) + "%'";
      }

      break;

    case 'startsWith':

      if(this.caseSensitive) {
        comparator = 'LIKE';
      }
      else {
        comparator = 'LIKE';
      }

      // Override comparator with WL Next features
      if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
        comparator = 'LIKE';
      }

      if(this.parameterized) {
        this.values.push(value + '%');
        str = comparator + " '" + '$' + this.paramCount + "'";
      }
      else {
        str = comparator + " '" + utils.escapeString(value, true) + "%'";
      }

      break;

    case 'endsWith':

      if(this.caseSensitive) {
        comparator = 'LIKE';
      }
      else {
        comparator = 'LIKE';
      }

      // Override comparator with WL Next features
      if(hop(self.wlNext, 'caseSensitive') && self.wlNext.caseSensitive) {
        comparator = 'LIKE';
      }

      if(this.parameterized) {
        this.values.push('%' + value);
        str = comparator + " '" + '$' + this.paramCount + "'";
      }
      else {
        str = comparator + " '%" + utils.escapeString(value, true) + "'";
      }

      break;

    default:
      var err = new Error('Unknown filtering operator: "' + key + "\". Should be 'startsWith', '>', 'contains' or similar");
      err.operator = key;
      throw err;
  }

  // Bump paramCount
  if(bumpParamCount) {
    this.paramCount++;
  }

  // Add str to query
  this.queryString += str;
};

/**
 * Specify a `limit` condition
 */

CriteriaProcessor.prototype.limit = function(options) {
  // Some MySQL hackery here.  For details, see:
  // http://stackoverflow.com/questions/255517/mysql-offset-infinite-rows
  if(options === null || options === undefined) {
    this.queryString += ' LIMIT 184467440737095516 ';
  }
  else {
    this.queryString += ' LIMIT ' + options;
  }
};

/**
 * Specify a `skip` condition
 */

CriteriaProcessor.prototype.skip = function(options) {
  this.queryString += ' OFFSET ' + options;
};

/**
 * Specify a `sort` condition
 */

CriteriaProcessor.prototype.sort = function(options) {
  options = utils.normalizeSort(options);
  var keys = _.keys(options);
  if (!keys.length) { return; }

  var self = this;
  this.queryString += ' ORDER BY ';

  _.each(keys, function(key) {
    var direction = options[key] === 1 ? 'ASC' : 'DESC';

    var split = key.split('.');
    if (split.length > 1) {
      var propertySchema = self.currentSchema[split[0]];
      var joinTableName = propertySchema.alias;
      var columnName = split[1];

      self.queryString += utils.escapeName(joinTableName, self.escapeCharacter) + '.' + utils.escapeName(columnName, self.escapeCharacter) + ' ' + direction + ', ';

      self.joins.push(propertySchema);
    } else {
      self.queryString += utils.escapeName(self.currentTable, self.escapeCharacter, self.schemaName) + '.' + utils.escapeName(key, self.escapeCharacter) + ' ' + direction + ', ';
    }

  });
  console.log(self.queryString);
  // Remove trailing comma
  this.queryString = this.queryString.slice(0, -2);
};

/**
 * Specify a `group by` condition
 */

CriteriaProcessor.prototype.group = function(options) {
  var self = this;

  this.queryString += ' GROUP BY ';

  // Normalize to array
  if(!_.isArray(options)) options = [options];

  _.each(options, function(key) {
    // Check whether we are grouping by a column or an expression.
    if (_.includes(_.keys(self.currentSchema), key)) {
      self.queryString += utils.escapeName(self.currentTable, self.escapeCharacter, self.schemaName) + '.' + utils.escapeName(key, self.escapeCharacter) + ', ';
    } else {
      self.queryString += key + ', ';
    }
  });

  // Remove trailing comma
  this.queryString = this.queryString.slice(0, -2);
};
