const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const {
  processNode,
  normaliseFieldName,
  mapMediaToNodes,
  mapProductsToCategories,
  mapProductsToTags,
  mapRelatedProducts,
  mapGroupedProducts,
  asyncGetProductVariations,
  asyncGetProductAttributes,
  timeStampedLog,
} = require("./helpers");

const {
  getWCNodeId,
  mapNodeNormalizeMetadata,
} = require("./helpers/misc-data");

exports.sourceNodes = async (
  { actions, createNodeId, createContentDigest, store, cache },
  configOptions
) => {
  const { createNode, touchNode } = actions;
  delete configOptions.plugins;

  const {
    api,
    https,
    api_keys,
    fields,
    api_version = "wc/v3",
    per_page,
    wpAPIPrefix = null,
    query_string_auth = false,
    port = "",
    encoding = "",
    axios_config = null,
    verbose = true,
  } = configOptions;

  // set up WooCommerce node api tool
  const WooCommerce = new WooCommerceRestApi({
    url: `http${https ? "s" : ""}://${api}`,
    consumerKey: api_keys.consumer_key,
    consumerSecret: api_keys.consumer_secret,
    version: api_version,
    wpAPIPrefix,
    queryStringAuth: query_string_auth,
    port,
    encoding,
    axiosConfig: axios_config,
  });

  // Fetch Node data for a given field name
  const fetchNodes = async (fieldName) => {
    let data_ = [];
    let translations = [];
    let page = 1;
    let pages;

    do {
      let args = per_page ? { per_page, page } : { page };
      await WooCommerce.get(fieldName, args)
      .then((response) => {
        if (response.status === 200) {
          data_ = [...data_, ...response.data];
          if(fieldName === 'products') {
            translations = [...translations, ...data_.map(data => data.translations.en)]

          }
          pages = parseInt(response.headers["x-wp-totalpages"]);
          page++;
        } else {
          console.warn(`
              ========== WARNING FOR FIELD ${fieldName} ===========
              The following error status was produced: ${response.data}
              ================== END WARNING ==================
            `);
          return [];
        }
      })
      .catch((error) => {
        console.warn(`
            ========== WARNING FOR FIELD ${fieldName} ===========
            The following error status was produced: ${error}
            ================== END WARNING ==================
          `);
        return [];
      });
    } while (page <= pages);

    if(fieldName === 'products') {
      translations = translations.filter(id => id != undefined).filter((v, i, a) => a.indexOf(v) === i)
      for(let i=0; i<translations.length; i++){
        const response = await WooCommerce.get(`products/${translations[i]}`);
        if(response.status === 200) {
          data_ = [...data_, response.data];
        } else {
          console.warn(`
              ========== WARNING FOR FIELD ${fieldName} ===========
              The following error status was produced: ${response.data}
              ================== END WARNING ==================
            `);
        }
      }
      return data_;
    } else{
      return data_;
    }

  };

  // Loop over each field set in configOptions and process/create nodes
  async function fetchNodesAndCreate(array) {
    let nodes = [];
    for (const field of array) {
      const fieldName = normaliseFieldName(field);
      let tempNodes = await fetchNodes(field);

      if (verbose) {
        timeStampedLog(
          `gatsby-source-woocommerce: Fetching ${tempNodes.length} nodes for field: ${field}`
        );
      }

      tempNodes = tempNodes.map((node) => ({
        ...node,
        id: createNodeId(
          `woocommerce-${fieldName}-${getWCNodeId(node, fieldName)}`
        ),
        wordpress_id: getWCNodeId(node, fieldName),
        wordpress_parent_id: node.parent,
        __type: `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`,
      }));
      nodes = nodes.concat(tempNodes);
      if (verbose) {
        timeStampedLog(
          `gatsby-source-woocommerce: Completed fetching nodes for field: ${field}`
        );
      }
    }
    nodes = await asyncGetProductVariations(nodes, WooCommerce, verbose);
    nodes = await asyncGetProductAttributes(nodes, WooCommerce, verbose);
    nodes = await mapMediaToNodes({
      nodes,
      store,
      cache,
      createNode,
      createNodeId,
      touchNode,
    });

    let startTime = new Date().getTime();

    nodes = mapProductsToCategories(nodes);
    nodes = mapProductsToTags(nodes);
    nodes = mapRelatedProducts(nodes);
    nodes = mapGroupedProducts(nodes);
    nodes = mapNodeNormalizeMetadata(nodes);

    nodes = nodes.map((node) =>
      processNode(createContentDigest, node, verbose, startTime)
    );

    nodes.forEach((node) => {
      createNode(node);
    });
    if (verbose) {
      timeStampedLog(
        `gatsby-source-woocommerce: ${
          nodes.length
        } nodes mapped, processed, and created in ${(new Date().getTime() -
          startTime) /
        1000}s`
      );
    }
  }
  await fetchNodesAndCreate(fields);
  return;
};

exports.createSchemaCustomization = ({ actions, schema }, configOptions) => {
  const { createTypes } = actions;
  const { fields } = configOptions;

  const typeDefs = fields.map((field) => {
    const fieldName = normaliseFieldName(field);
    const fieldType = `wc${fieldName[0].toUpperCase() + fieldName.slice(1)}`;

    return schema.buildObjectType({
      name: fieldType,
      fields: {
        wordpress_parent: {
          type: fieldType,
          resolve(source, args, context, info) {
            return context.nodeModel
            .getAllNodes({ type: fieldType })
            .find((node) => node.wordpress_id === source.wordpress_parent_id);
          },
        },
        wordpress_children: {
          type: `[${fieldType}]`,
          resolve(source, args, context, info) {
            return context.nodeModel
            .getAllNodes({ type: fieldType })
            .filter(
              (node) => node.wordpress_parent_id === source.wordpress_id
            );
          },
        },
      },
      interfaces: ["Node"],
    });
  });

  createTypes(typeDefs);
};
